-- =====================================================================
-- Module M08 — Production (Work Orders) : incremental migration
-- Brings the base mfg.work_order family (db/03_hcm_mfg_scm.sql) up to the
-- platform's branch-numbering + multi-tenant RLS conventions so the production
-- module can serve them through the RLS-enforced erp_app role:
--   * bu_id          — branch, required to allocate a branch-scoped WO number
--   * status ON_HOLD — extend the lifecycle (base ck already has PLANNED/
--                      RELEASED/IN_PROGRESS/COMPLETED/CLOSED/CANCELLED)
--   * qty_rework     — production_confirmation gains a rework qty (base has
--                      qty_done / qty_scrap / labour_hours only)
--   * a 'WORK_ORDER' numbering rule (branch-scoped, prefix 'WO') — NOT in the
--     db/07 seed, so we add it here (guarded ON CONFLICT DO NOTHING)
--   * RLS ENABLE + per-company policy FOR ALL TO erp_app (ENABLE, not FORCE: the
--     owner/superuser used by tests + migrations bypasses, exactly like 003/006)
--   * the composite (company_id, bu_id) FK and List-screen indexes
--   * DELETE grant on the operation / material child tables the app replaces
-- The audit trigger trg_audit_wo is ALREADY attached in db/06 (do NOT re-create).
-- company_id, row_version, is_deleted already exist on mfg.work_order (db/03).
-- Idempotent. Apply AFTER 005_rls_role_grants.sql (and db/00_run_all.sql).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Branch (numbering scope). company_id already exists (db/03); add only bu_id.
-- ---------------------------------------------------------------------
ALTER TABLE mfg.work_order
  ADD COLUMN IF NOT EXISTS bu_id BIGINT REFERENCES mdm.business_unit(bu_id);

-- ---------------------------------------------------------------------
-- 2. Lifecycle: add ON_HOLD (pause/resume) to the work-order status check.
--    Keep the base states PLANNED/RELEASED/IN_PROGRESS/COMPLETED/CLOSED/CANCELLED.
-- ---------------------------------------------------------------------
ALTER TABLE mfg.work_order ALTER COLUMN status SET DEFAULT 'PLANNED';
ALTER TABLE mfg.work_order DROP CONSTRAINT IF EXISTS ck_wo_status;
ALTER TABLE mfg.work_order ADD CONSTRAINT ck_wo_status CHECK (status IN
  ('PLANNED','RELEASED','IN_PROGRESS','COMPLETED','ON_HOLD','CLOSED','CANCELLED'));

-- ---------------------------------------------------------------------
-- 3. Rework quantity on the production confirmation (scrap/rework are distinct).
-- ---------------------------------------------------------------------
ALTER TABLE mfg.production_confirmation
  ADD COLUMN IF NOT EXISTS qty_rework NUMERIC(20,4) NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------
-- 4. Helpful indexes for the List screen filters (ix_wo_project/status/item
--    already exist from db/03; add the company-scoped composite + wo_no search).
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ix_wo_company_status ON mfg.work_order(company_id, status);
CREATE INDEX IF NOT EXISTS ix_wo_no             ON mfg.work_order(wo_no);

-- ---------------------------------------------------------------------
-- 5. ROW-LEVEL SECURITY (per-company), mirroring the sales surface (003).
--    ENABLE (not FORCE) is deliberate: the table owner / superuser BYPASSES RLS,
--    so migrations + the test harness (which connect as the owner) are not
--    filtered. Enforcement applies ONLY to the non-superuser erp_app login role.
--    Scope is taken from the transaction-local GUC app.company_id.
-- ---------------------------------------------------------------------
ALTER TABLE mfg.work_order ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE mfg.work_order IS
  'RLS ENABLED (not FORCE): rls_work_order_company scopes rows to app.company_id for the erp_app role only; the owner/superuser bypasses (used by tests + migrations).';

DROP POLICY IF EXISTS rls_work_order_company ON mfg.work_order;
CREATE POLICY rls_work_order_company ON mfg.work_order
  FOR ALL TO erp_app
  USING      (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint);

-- ---------------------------------------------------------------------
-- 6. BUSINESS-UNIT / COMPANY INTEGRITY: a WO's branch must belong to its company.
--    bu_id is nullable; MATCH SIMPLE skips the check when NULL. uq_bu_company
--    exists from 003_security_hardening.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_wo_bu_company'
      AND conrelid = 'mfg.work_order'::regclass
  ) THEN
    ALTER TABLE mfg.work_order
      ADD CONSTRAINT fk_wo_bu_company
      FOREIGN KEY (company_id, bu_id)
      REFERENCES mdm.business_unit (company_id, bu_id);
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 7. NUMBERING RULE for 'WORK_ORDER' — branch-scoped, prefix 'WO', FY reset.
--    Not present in the db/07 seed, so add one rule per BE branch. Mirrors the
--    db/07 / 002 pattern; guarded so re-runs are no-ops.
-- ---------------------------------------------------------------------
INSERT INTO mdm.numbering_rule (company_id, bu_id, doc_type, prefix, format_template, pad_width, reset_policy)
SELECT c.company_id, bu.bu_id, 'WORK_ORDER', 'WO', '{PREFIX}/{BRANCH}/{FY}/{SEQ}', 6, 'FY'
FROM mdm.company c
JOIN mdm.business_unit bu ON bu.company_id = c.company_id
WHERE c.company_code = 'BE'
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------
-- 8. CHILD-TABLE DELETE GRANTS. The app fully replaces a work order's operation
--    and material lines when the plan is (re-)saved (pre-release), so erp_app
--    needs DELETE on these children (db/08 granted only SELECT/INSERT/UPDATE).
--    The parent mfg.work_order keeps soft-delete only (no DELETE grant). The app
--    also writes production_confirmation rows and as_built / serial_number on
--    confirm/complete — grant INSERT defensively (base grants normally cover it).
-- ---------------------------------------------------------------------
GRANT DELETE ON mfg.work_order_operation, mfg.work_order_material TO erp_app;
GRANT SELECT, INSERT ON mfg.production_confirmation, mfg.as_built TO erp_app;
GRANT SELECT, INSERT, UPDATE ON scm.serial_number TO erp_app;

-- End migration 012_production.
