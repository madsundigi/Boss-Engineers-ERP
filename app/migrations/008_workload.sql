-- =====================================================================
-- Module M07 — Employee Workload : incremental migration
-- Brings the base HCM allocation/timesheet tables (db/03_hcm_mfg_scm.sql) up to
-- the platform's multi-tenant + optimistic-concurrency + audit conventions so
-- the workload module can serve them through the RLS-enforced erp_app role:
--   * company_id  — tenant scope for RLS (the base tables were company-implicit
--                   via employee; we make it explicit so RLS can filter directly)
--   * row_version — optimistic concurrency (409 on mismatch) for confirm/approve
--   * RLS ENABLE + per-company policy FOR ALL TO erp_app (ENABLE, not FORCE: the
--     owner/superuser used by tests + migrations bypasses, exactly like 003)
--   * audit triggers via audit.fn_audit('<pk>') on the mutable tables
--   * DELETE grant on the timesheet child line table (header is status-managed)
-- Idempotent. Apply AFTER 005_rls_role_grants.sql (and db/00_run_all.sql).
-- =====================================================================

-- ---------------------------------------------------------------------
-- a. TENANT SCOPE (company_id) on the allocation + timesheet tables
--    Nullable-add, backfill from the owning employee, then enforce NOT NULL.
--    timesheet_line is scoped transitively through its parent timesheet, so it
--    needs no company_id of its own (mirrors sales.*_line).
-- ---------------------------------------------------------------------
ALTER TABLE hcm.resource_allocation
  ADD COLUMN IF NOT EXISTS company_id  BIGINT REFERENCES mdm.company(company_id),
  ADD COLUMN IF NOT EXISTS row_version INT NOT NULL DEFAULT 1;

ALTER TABLE hcm.timesheet
  ADD COLUMN IF NOT EXISTS company_id  BIGINT REFERENCES mdm.company(company_id),
  ADD COLUMN IF NOT EXISTS row_version INT NOT NULL DEFAULT 1;

UPDATE hcm.resource_allocation a
   SET company_id = e.company_id
  FROM hcm.employee e
 WHERE e.employee_id = a.employee_id AND a.company_id IS NULL;

UPDATE hcm.timesheet t
   SET company_id = e.company_id
  FROM hcm.employee e
 WHERE e.employee_id = t.employee_id AND t.company_id IS NULL;

ALTER TABLE hcm.resource_allocation ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE hcm.timesheet           ALTER COLUMN company_id SET NOT NULL;

-- Helpful indexes for the List + capacity screens.
CREATE INDEX IF NOT EXISTS ix_alloc_company_date ON hcm.resource_allocation(company_id, alloc_date);
CREATE INDEX IF NOT EXISTS ix_ts_company         ON hcm.timesheet(company_id, period_start);

-- ---------------------------------------------------------------------
-- b. ROW-LEVEL SECURITY (per-company), mirroring 003_security_hardening.
--    ENABLE (not FORCE): owner/superuser (tests + migrations) bypass; only the
--    non-superuser erp_app login role is filtered. Scope rows to app.company_id.
--    timesheet_line is reached only via its parent (already company-scoped) so a
--    direct policy is unnecessary; the app never queries lines cross-tenant.
-- ---------------------------------------------------------------------
ALTER TABLE hcm.resource_allocation ENABLE ROW LEVEL SECURITY;
ALTER TABLE hcm.timesheet           ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE hcm.resource_allocation IS
  'RLS ENABLED (not FORCE): rls_alloc_company scopes rows to app.company_id for the erp_app role only; the owner/superuser bypasses (used by tests + migrations).';
COMMENT ON TABLE hcm.timesheet IS
  'RLS ENABLED (not FORCE): rls_timesheet_company scopes rows to app.company_id for the erp_app role only; the owner/superuser bypasses (used by tests + migrations).';

DROP POLICY IF EXISTS rls_alloc_company ON hcm.resource_allocation;
CREATE POLICY rls_alloc_company ON hcm.resource_allocation
  FOR ALL TO erp_app
  USING      (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint);

DROP POLICY IF EXISTS rls_timesheet_company ON hcm.timesheet;
CREATE POLICY rls_timesheet_company ON hcm.timesheet
  FOR ALL TO erp_app
  USING      (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint);

-- ---------------------------------------------------------------------
-- c. AUDIT triggers (reuse the platform audit.fn_audit, parameterized by PK).
--    Attribution is taken from the app.* session GUCs the app sets per request.
-- ---------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_alloc_audit ON hcm.resource_allocation;
CREATE TRIGGER trg_alloc_audit
  AFTER INSERT OR UPDATE OR DELETE ON hcm.resource_allocation
  FOR EACH ROW EXECUTE FUNCTION audit.fn_audit('alloc_id');

DROP TRIGGER IF EXISTS trg_timesheet_audit ON hcm.timesheet;
CREATE TRIGGER trg_timesheet_audit
  AFTER INSERT OR UPDATE OR DELETE ON hcm.timesheet
  FOR EACH ROW EXECUTE FUNCTION audit.fn_audit('ts_id');

-- ---------------------------------------------------------------------
-- d. GRANTS for the erp_app role.
--    Base db/08 already granted SELECT/INSERT/UPDATE on all hcm tables. The app
--    re-creates a timesheet's lines by replacing the child set, so it needs
--    DELETE on the line table (the header keeps status-managed lifecycle, no
--    DELETE) — least privilege, mirroring 005_rls_role_grants for sales lines.
-- ---------------------------------------------------------------------
GRANT DELETE ON hcm.timesheet_line TO erp_app;

-- End migration 008_workload.
