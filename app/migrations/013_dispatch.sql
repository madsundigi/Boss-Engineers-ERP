-- =====================================================================
-- Module M11 — Dispatch : incremental migration
-- Extends base log.dispatch (db/04) into a MULTI-GATE RELEASE: a dispatch is
-- shipped (RELEASED) only after BOTH a Quality (QC) and a Commercial (Finance /
-- payment) clearance gate are open. Adds the branch (numbering scope), the gate-
-- tracking columns, the new status lifecycle, per-company Row-Level Security,
-- the composite (company_id, bu_id) FK, and the child-table DELETE grants the
-- app needs to replace serial lines / packing lists. The audit trigger
-- trg_audit_dispatch is already attached in db/06 (dispatch_id).
-- Idempotent. Apply AFTER the base schema (db/00_run_all.sql) and migration 009.
-- =====================================================================

-- 1. Branch (numbering scope) + tenant column. company_id already exists on
--    log.dispatch (db/04); add only if missing. bu_id is the numbering scope.
ALTER TABLE log.dispatch
  ADD COLUMN IF NOT EXISTS company_id BIGINT REFERENCES mdm.company(company_id),
  ADD COLUMN IF NOT EXISTS bu_id      BIGINT REFERENCES mdm.business_unit(bu_id);

-- 2. Gate-tracking columns: who/when cleared each independent release gate.
--    Both must be set before a dispatch can move DRAFT -> RELEASED.
ALTER TABLE log.dispatch
  ADD COLUMN IF NOT EXISTS quality_cleared_by      BIGINT REFERENCES sec.app_user(user_id),
  ADD COLUMN IF NOT EXISTS quality_cleared_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS commercial_cleared_by   BIGINT REFERENCES sec.app_user(user_id),
  ADD COLUMN IF NOT EXISTS commercial_cleared_at   TIMESTAMPTZ;

-- 3. Lifecycle: DRAFT -> (both gates cleared) -> RELEASED -> DELIVERED (+ CANCELLED).
--    Replace the base CHECK (READY/GATE_PASS/DISPATCHED/DELIVERED, db/04) and move
--    the default to DRAFT. Migrate any legacy rows so the new CHECK can attach.
ALTER TABLE log.dispatch DROP CONSTRAINT IF EXISTS ck_dispatch_status;
UPDATE log.dispatch SET status = CASE status
    WHEN 'READY'      THEN 'DRAFT'
    WHEN 'GATE_PASS'  THEN 'DRAFT'
    WHEN 'DISPATCHED' THEN 'RELEASED'
    ELSE status                       -- DELIVERED stays DELIVERED
  END
  WHERE status IN ('READY','GATE_PASS','DISPATCHED');
ALTER TABLE log.dispatch ALTER COLUMN status SET DEFAULT 'DRAFT';
ALTER TABLE log.dispatch ADD CONSTRAINT ck_dispatch_status
  CHECK (status IN ('DRAFT','RELEASED','DELIVERED','CANCELLED'));

-- 4. Helpful index for the List screen filters.
CREATE INDEX IF NOT EXISTS ix_dispatch_company_status ON log.dispatch(company_id, status);

-- ---------------------------------------------------------------------
-- 5. ROW-LEVEL SECURITY (per-company), mirroring the sales surface (003).
--    ENABLE (not FORCE) is deliberate: the table owner / superuser BYPASSES
--    RLS, so migrations + the test harness (which connect as the owner) are not
--    filtered. Enforcement applies ONLY to the non-superuser erp_app login role.
-- ---------------------------------------------------------------------
ALTER TABLE log.dispatch ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE log.dispatch IS
  'RLS ENABLED (not FORCE): rls_dispatch_company scopes rows to app.company_id for the erp_app role only; the owner/superuser bypasses (used by tests + migrations). Multi-gate release: quality + commercial clearance both required before RELEASED.';

DROP POLICY IF EXISTS rls_dispatch_company ON log.dispatch;
CREATE POLICY rls_dispatch_company ON log.dispatch
  FOR ALL TO erp_app
  USING      (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint);

-- ---------------------------------------------------------------------
-- 6. BUSINESS-UNIT / COMPANY INTEGRITY: a dispatch's branch must belong to its
--    company. bu_id is nullable; MATCH SIMPLE skips the check when NULL, so a
--    company-wide (branchless) dispatch still works. uq_bu_company exists from 003.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_dispatch_bu_company'
      AND conrelid = 'log.dispatch'::regclass
  ) THEN
    ALTER TABLE log.dispatch
      ADD CONSTRAINT fk_dispatch_bu_company
      FOREIGN KEY (company_id, bu_id)
      REFERENCES mdm.business_unit (company_id, bu_id);
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 7. CHILD-TABLE DELETE GRANTS. The app fully replaces a dispatch's serial lines
--    and packing list when they are (re-)edited, so erp_app needs DELETE on these
--    children (db/06 granted only SELECT/INSERT/UPDATE). The parent log.dispatch
--    keeps soft-delete only (no DELETE grant).
-- ---------------------------------------------------------------------
GRANT DELETE ON log.dispatch_line, log.packing_list TO erp_app;

-- End migration 013_dispatch.
