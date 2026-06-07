-- =====================================================================
-- Module M04 — Project Planning & Gantt : incremental migration
-- Brings the base planning tables (db/02_sales_project.sql) up to the platform's
-- multi-tenant + audit conventions so the planning module can serve them through
-- the RLS-enforced erp_app role. The base tables are project-scoped (project_id)
-- but company-implicit; we add an explicit company_id (backfilled from
-- proj.project) so Row-Level Security can filter directly, then:
--   * RLS ENABLE + per-company policy FOR ALL TO erp_app (ENABLE, not FORCE: the
--     owner/superuser used by tests + migrations bypasses, exactly like 003/006)
--   * audit triggers via audit.fn_audit('<pk>') on the mutable tables (these are
--     NOT attached in db/06 — only proj.project / proj.change_order are)
--   * DELETE grant on proj.task_dependency — the app fully replaces a task's
--     predecessor set on each task save (header keeps soft-delete; least priv.)
-- Planning uses identity PKs (GENERATED ALWAYS AS IDENTITY) — no document
-- numbering (mdm.next_document_no) is involved.
-- Idempotent. Apply AFTER 009_fat.sql (and db/00_run_all.sql).
-- =====================================================================

-- ---------------------------------------------------------------------
-- a. TENANT SCOPE (company_id). Nullable-add, backfill from the owning
--    proj.project, then enforce NOT NULL. task_dependency is reached only via
--    its parent task (already company-scoped) so it needs no company_id — it is
--    never queried cross-tenant (mirrors sales.*_line).
-- ---------------------------------------------------------------------
ALTER TABLE proj.wbs_element ADD COLUMN IF NOT EXISTS company_id BIGINT REFERENCES mdm.company(company_id);
ALTER TABLE proj.task        ADD COLUMN IF NOT EXISTS company_id BIGINT REFERENCES mdm.company(company_id);
ALTER TABLE proj.milestone   ADD COLUMN IF NOT EXISTS company_id BIGINT REFERENCES mdm.company(company_id);
ALTER TABLE proj.baseline    ADD COLUMN IF NOT EXISTS company_id BIGINT REFERENCES mdm.company(company_id);

UPDATE proj.wbs_element w SET company_id = p.company_id
  FROM proj.project p WHERE p.project_id = w.project_id AND w.company_id IS NULL;
UPDATE proj.task t SET company_id = p.company_id
  FROM proj.project p WHERE p.project_id = t.project_id AND t.company_id IS NULL;
UPDATE proj.milestone m SET company_id = p.company_id
  FROM proj.project p WHERE p.project_id = m.project_id AND m.company_id IS NULL;
UPDATE proj.baseline b SET company_id = p.company_id
  FROM proj.project p WHERE p.project_id = b.project_id AND b.company_id IS NULL;

ALTER TABLE proj.wbs_element ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE proj.task        ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE proj.milestone   ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE proj.baseline    ALTER COLUMN company_id SET NOT NULL;

-- Helpful indexes for the schedule / list screens.
CREATE INDEX IF NOT EXISTS ix_wbs_company       ON proj.wbs_element(company_id, project_id);
CREATE INDEX IF NOT EXISTS ix_task_company      ON proj.task(company_id, project_id);
CREATE INDEX IF NOT EXISTS ix_milestone_company ON proj.milestone(company_id, project_id);
CREATE INDEX IF NOT EXISTS ix_baseline_company  ON proj.baseline(company_id, project_id);

-- ---------------------------------------------------------------------
-- b. ROW-LEVEL SECURITY (per-company), mirroring 003/006. ENABLE (not FORCE):
--    owner/superuser (tests + migrations) bypass; only the non-superuser erp_app
--    login role is filtered. Scope rows to the transaction-local app.company_id.
-- ---------------------------------------------------------------------
ALTER TABLE proj.wbs_element ENABLE ROW LEVEL SECURITY;
ALTER TABLE proj.task        ENABLE ROW LEVEL SECURITY;
ALTER TABLE proj.milestone   ENABLE ROW LEVEL SECURITY;
ALTER TABLE proj.baseline    ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE proj.wbs_element IS
  'RLS ENABLED (not FORCE): rls_wbs_company scopes rows to app.company_id for the erp_app role only; the owner/superuser bypasses (used by tests + migrations).';
COMMENT ON TABLE proj.task IS
  'RLS ENABLED (not FORCE): rls_task_company scopes rows to app.company_id for the erp_app role only; the owner/superuser bypasses (used by tests + migrations).';
COMMENT ON TABLE proj.milestone IS
  'RLS ENABLED (not FORCE): rls_milestone_company scopes rows to app.company_id for the erp_app role only; the owner/superuser bypasses (used by tests + migrations).';
COMMENT ON TABLE proj.baseline IS
  'RLS ENABLED (not FORCE): rls_baseline_company scopes rows to app.company_id for the erp_app role only; the owner/superuser bypasses (used by tests + migrations).';

DROP POLICY IF EXISTS rls_wbs_company ON proj.wbs_element;
CREATE POLICY rls_wbs_company ON proj.wbs_element
  FOR ALL TO erp_app
  USING      (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint);

DROP POLICY IF EXISTS rls_task_company ON proj.task;
CREATE POLICY rls_task_company ON proj.task
  FOR ALL TO erp_app
  USING      (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint);

DROP POLICY IF EXISTS rls_milestone_company ON proj.milestone;
CREATE POLICY rls_milestone_company ON proj.milestone
  FOR ALL TO erp_app
  USING      (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint);

DROP POLICY IF EXISTS rls_baseline_company ON proj.baseline;
CREATE POLICY rls_baseline_company ON proj.baseline
  FOR ALL TO erp_app
  USING      (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint);

-- ---------------------------------------------------------------------
-- c. AUDIT triggers (reuse the platform audit.fn_audit, parameterized by PK).
--    Attribution is taken from the app.* session GUCs the app sets per request.
--    db/06 attaches audit only to proj.project / proj.change_order, so the
--    planning tables need theirs here.
-- ---------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_audit_wbs ON proj.wbs_element;
CREATE TRIGGER trg_audit_wbs
  AFTER INSERT OR UPDATE OR DELETE ON proj.wbs_element
  FOR EACH ROW EXECUTE FUNCTION audit.fn_audit('wbs_id');

DROP TRIGGER IF EXISTS trg_audit_task ON proj.task;
CREATE TRIGGER trg_audit_task
  AFTER INSERT OR UPDATE OR DELETE ON proj.task
  FOR EACH ROW EXECUTE FUNCTION audit.fn_audit('task_id');

DROP TRIGGER IF EXISTS trg_audit_milestone ON proj.milestone;
CREATE TRIGGER trg_audit_milestone
  AFTER INSERT OR UPDATE OR DELETE ON proj.milestone
  FOR EACH ROW EXECUTE FUNCTION audit.fn_audit('milestone_id');

DROP TRIGGER IF EXISTS trg_audit_baseline ON proj.baseline;
CREATE TRIGGER trg_audit_baseline
  AFTER INSERT OR UPDATE OR DELETE ON proj.baseline
  FOR EACH ROW EXECUTE FUNCTION audit.fn_audit('baseline_id');

-- ---------------------------------------------------------------------
-- d. GRANTS for the erp_app role. Base db/06 already granted
--    SELECT/INSERT/UPDATE on all proj tables. The app re-creates a task's
--    predecessor edges by replacing the child set, so it needs DELETE on
--    proj.task_dependency (the tasks themselves keep soft-delete, no DELETE) —
--    least privilege, mirroring 005_rls_role_grants / 008 / 009.
-- ---------------------------------------------------------------------
GRANT DELETE ON proj.task_dependency TO erp_app;

-- End migration 010_planning.
