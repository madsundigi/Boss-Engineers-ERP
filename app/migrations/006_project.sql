-- =====================================================================
-- Module M03 — Project Creation : incremental migration
-- Extends base proj.project (db/02) for: branch (numbering), a charter
-- approval gate (APPROVED), per-company Row-Level Security, and List-screen
-- indexes. The project number is the costing spine for all downstream actuals
-- (db/07 already seeds the 'PROJECT' numbering rule, prefix PRJ).
-- Audit + status-history triggers are ALREADY attached in db/06
-- (trg_audit_project / trg_status_project) — do NOT re-create them here.
-- Idempotent. Apply AFTER 005_rls_role_grants.sql.
-- =====================================================================

-- 1. Branch column — required to allocate a branch-scoped project number.
ALTER TABLE proj.project
  ADD COLUMN IF NOT EXISTS bu_id BIGINT REFERENCES mdm.business_unit(bu_id);

-- 2. Lifecycle: add the charter/budget-approval gate (APPROVED) ahead of ACTIVE.
--    Keep the base states (PLANNING/ACTIVE/ON_HOLD/DELIVERED/CLOSED/CANCELLED).
ALTER TABLE proj.project ALTER COLUMN status SET DEFAULT 'PLANNING';
ALTER TABLE proj.project DROP CONSTRAINT IF EXISTS ck_project_status;
ALTER TABLE proj.project ADD CONSTRAINT ck_project_status CHECK (status IN
  ('PLANNING','APPROVED','ACTIVE','ON_HOLD','DELIVERED','CLOSED','CANCELLED'));

-- 3. Business-unit / company integrity: a project's branch must belong to its
--    company. bu_id is nullable; MATCH SIMPLE skips the check when bu_id is NULL.
--    (uq_bu_company on mdm.business_unit was added in 003_security_hardening.)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_project_bu_company'
      AND conrelid = 'proj.project'::regclass
  ) THEN
    ALTER TABLE proj.project
      ADD CONSTRAINT fk_project_bu_company
      FOREIGN KEY (company_id, bu_id)
      REFERENCES mdm.business_unit (company_id, bu_id);
  END IF;
END $$;

-- 4. ROW-LEVEL SECURITY (per-company scope), mirroring the sales surface (003).
--    ENABLE (not FORCE) is deliberate: the owner/superuser bypasses (used by the
--    test harness + migrations); enforcement applies only to the erp_app login
--    role used in production. Scope is taken from the transaction-local GUC
--    app.company_id that the app sets on each connection checkout.
ALTER TABLE proj.project ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE proj.project IS
  'RLS ENABLED (not FORCE): rls_project_company scopes rows to app.company_id for the erp_app role only; the owner/superuser bypasses (used by tests + migrations).';

DROP POLICY IF EXISTS rls_project_company ON proj.project;
CREATE POLICY rls_project_company ON proj.project
  FOR ALL TO erp_app
  USING      (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint);

-- 5. Helpful indexes for the List screen filters.
CREATE INDEX IF NOT EXISTS ix_project_company_status ON proj.project(company_id, status);
CREATE INDEX IF NOT EXISTS ix_project_quotation      ON proj.project(quotation_id);

-- End migration 006_project.
