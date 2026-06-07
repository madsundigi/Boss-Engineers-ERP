-- =====================================================================
-- Module M10 — FAT (Factory Acceptance Test) : incremental migration
-- Extends base qms.fat_execution (db/04) with a branch (numbering scope) and a
-- user-facing lifecycle Status (the base table ships only a `result` column).
-- Adds per-company Row-Level Security, the composite (company_id, bu_id) FK, and
-- the child-table DELETE grants the app needs to replace result lines / punch
-- items. The audit trigger trg_audit_fat is already attached in db/06.
-- Idempotent. Apply AFTER the base schema (db/00_run_all.sql) and migration 008.
-- =====================================================================

-- 1. Branch (numbering scope) + lifecycle status.
--    company_id already exists on qms.fat_execution (db/04); only add if missing.
ALTER TABLE qms.fat_execution
  ADD COLUMN IF NOT EXISTS company_id BIGINT REFERENCES mdm.company(company_id),
  ADD COLUMN IF NOT EXISTS bu_id      BIGINT REFERENCES mdm.business_unit(bu_id),
  ADD COLUMN IF NOT EXISTS status     VARCHAR(15) NOT NULL DEFAULT 'SCHEDULED';

-- 2. Lifecycle domain: SCHEDULED -> IN_PROGRESS -> PASSED|FAILED -> CLEARED.
--    CLEARED is the Dispatch-clearance gate (log.dispatch.fat_id).
ALTER TABLE qms.fat_execution DROP CONSTRAINT IF EXISTS ck_fat_status;
ALTER TABLE qms.fat_execution ADD CONSTRAINT ck_fat_status
  CHECK (status IN ('SCHEDULED','IN_PROGRESS','PASSED','FAILED','CLEARED','CANCELLED'));

-- 3. Helpful index for the List screen filters.
CREATE INDEX IF NOT EXISTS ix_fat_company_status ON qms.fat_execution(company_id, status);

-- ---------------------------------------------------------------------
-- 4. ROW-LEVEL SECURITY (per-company), mirroring the sales surface (003).
--    ENABLE (not FORCE) is deliberate: the table owner / superuser BYPASSES
--    RLS, so migrations + the test harness (which connect as the owner) are not
--    filtered. Enforcement applies ONLY to the non-superuser erp_app login role.
-- ---------------------------------------------------------------------
ALTER TABLE qms.fat_execution ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE qms.fat_execution IS
  'RLS ENABLED (not FORCE): rls_fat_company scopes rows to app.company_id for the erp_app role only; the owner/superuser bypasses (used by tests + migrations).';

DROP POLICY IF EXISTS rls_fat_company ON qms.fat_execution;
CREATE POLICY rls_fat_company ON qms.fat_execution
  FOR ALL TO erp_app
  USING      (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint);

-- ---------------------------------------------------------------------
-- 5. BUSINESS-UNIT / COMPANY INTEGRITY: a FAT's branch must belong to its
--    company. bu_id is nullable; MATCH SIMPLE skips the check when NULL, so a
--    company-wide (branchless) FAT still works. uq_bu_company exists from 003.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_fat_bu_company'
      AND conrelid = 'qms.fat_execution'::regclass
  ) THEN
    ALTER TABLE qms.fat_execution
      ADD CONSTRAINT fk_fat_bu_company
      FOREIGN KEY (company_id, bu_id)
      REFERENCES mdm.business_unit (company_id, bu_id);
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 6. CHILD-TABLE DELETE GRANTS. The app fully replaces a FAT's measured result
--    lines and punch items when a result is (re-)recorded, so erp_app needs
--    DELETE on these children (db/06 granted only SELECT/INSERT/UPDATE). The
--    parent qms.fat_execution keeps soft-delete only (no DELETE grant).
-- ---------------------------------------------------------------------
GRANT DELETE ON qms.fat_result_line, qms.punch_item TO erp_app;

-- End migration 009_fat.
