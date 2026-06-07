-- =====================================================================
-- Module — Engineering / Bill of Materials (BOM) : incremental migration
-- Brings the base mdm.bom_header / mdm.bom_line family (db/01_security_master)
-- up to the platform's branch-numbering + multi-tenant RLS conventions so the
-- BOM module can serve them through the RLS-enforced erp_app role:
--   * bu_id          — branch, required to allocate a branch-scoped BOM number
--                      (company_id, the status & bom_type CHECKs all exist in db/01)
--   * a 'BOM' numbering rule (branch-scoped, prefix 'BOM', FY reset) — NOT in the
--     db/07 seed, so we add one per BE branch (guarded ON CONFLICT DO NOTHING)
--   * RLS ENABLE + per-company policy FOR ALL TO erp_app (ENABLE, not FORCE: the
--     owner/superuser used by tests + migrations bypasses, exactly like 003/012/013)
--   * the composite (company_id, bu_id) FK and a List-screen index
--   * the field-level audit trigger trg_audit_bom (NOT created in db/06) — added if
--     absent, exactly like 013_dispatch / 015_service do for their tables
--   * DELETE grant on the mdm.bom_line child (the app fully replaces the lines on edit)
-- bom_line carries NO company_id; it is reached via the header, so it needs no RLS.
-- The BOM permission + RBAC grants are ALREADY seeded in db/08 — so we seed NONE.
-- company_id, row_version, is_deleted already exist on mdm.bom_header (db/01).
-- Idempotent. Apply AFTER 005_rls_role_grants.sql (and db/00_run_all.sql).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Branch (numbering scope). company_id already exists (db/01); add only bu_id.
-- ---------------------------------------------------------------------
ALTER TABLE mdm.bom_header
  ADD COLUMN IF NOT EXISTS bu_id BIGINT REFERENCES mdm.business_unit(bu_id);

-- ---------------------------------------------------------------------
-- 2. NUMBERING RULE for 'BOM' — branch-scoped, prefix 'BOM', FY reset. Not present
--    in the db/07 seed, so add one rule per BE branch. Mirrors the 012 pattern;
--    guarded so re-runs are no-ops.
-- ---------------------------------------------------------------------
INSERT INTO mdm.numbering_rule (company_id, bu_id, doc_type, prefix, format_template, pad_width, reset_policy)
SELECT c.company_id, bu.bu_id, 'BOM', 'BOM', '{PREFIX}/{BRANCH}/{FY}/{SEQ}', 6, 'FY'
FROM mdm.company c
JOIN mdm.business_unit bu ON bu.company_id = c.company_id
WHERE c.company_code = 'BE'
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------
-- 3. Helpful index for the List screen filters (ix_bom_status already exists from
--    db/01; add the company-scoped composite).
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ix_bom_company_status ON mdm.bom_header(company_id, status);

-- ---------------------------------------------------------------------
-- 4. ROW-LEVEL SECURITY (per-company), mirroring the sales surface (003).
--    ENABLE (not FORCE) is deliberate: the table owner / superuser BYPASSES RLS,
--    so migrations + the test harness (which connect as the owner) are not
--    filtered. Enforcement applies ONLY to the non-superuser erp_app login role.
--    Scope is taken from the transaction-local GUC app.company_id.
-- ---------------------------------------------------------------------
ALTER TABLE mdm.bom_header ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE mdm.bom_header IS
  'RLS ENABLED (not FORCE): rls_bom_company scopes rows to app.company_id for the erp_app role only; the owner/superuser bypasses (used by tests + migrations). Lifecycle: DRAFT->RELEASED->OBSOLETE.';

DROP POLICY IF EXISTS rls_bom_company ON mdm.bom_header;
CREATE POLICY rls_bom_company ON mdm.bom_header
  FOR ALL TO erp_app
  USING      (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint);

-- ---------------------------------------------------------------------
-- 5. BUSINESS-UNIT / COMPANY INTEGRITY: a BOM's branch must belong to its company.
--    bu_id is nullable; MATCH SIMPLE skips the check when NULL, so a company-wide
--    (branchless) BOM still works. uq_bu_company exists from 003.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_bom_bu_company'
      AND conrelid = 'mdm.bom_header'::regclass
  ) THEN
    ALTER TABLE mdm.bom_header
      ADD CONSTRAINT fk_bom_bu_company
      FOREIGN KEY (company_id, bu_id)
      REFERENCES mdm.business_unit (company_id, bu_id) MATCH SIMPLE;
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 6. AUDIT TRIGGER. db/06 does NOT attach any audit trigger to mdm.bom_header.
--    Add trg_audit_bom (audit.fn_audit on the PK 'bom_id') if it is not already
--    present, so CREATE/EDIT/DELETE are captured in audit.audit_log — exactly like
--    013_dispatch / 015_service add theirs.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_audit_bom'
      AND tgrelid = 'mdm.bom_header'::regclass
  ) THEN
    CREATE TRIGGER trg_audit_bom
      AFTER INSERT OR UPDATE OR DELETE ON mdm.bom_header
      FOR EACH ROW EXECUTE FUNCTION audit.fn_audit('bom_id');
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 7. CHILD-TABLE DELETE GRANT. The app fully replaces a BOM's component lines when
--    they are (re-)edited, so erp_app needs DELETE on mdm.bom_line (db/06 granted
--    only SELECT/INSERT/UPDATE). The parent mdm.bom_header keeps soft-delete only
--    (no DELETE grant).
-- ---------------------------------------------------------------------
GRANT DELETE ON mdm.bom_line TO erp_app;

-- End migration 018_bom.
