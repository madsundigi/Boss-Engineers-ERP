-- =====================================================================
-- Module M14 — Failure Analysis (NCR -> RCA -> CAPA) : incremental migration
-- Brings the base qms.ncr family (db/04_qms_log_svc.sql) up to the platform's
-- branch-numbering + multi-tenant RLS conventions so the failure module can serve
-- the quality nonconformance / 8D workflow through the RLS-enforced erp_app role:
--   * bu_id            — branch, required to allocate a branch-scoped NCR number
--   * a 'NCR' numbering rule (branch-scoped, prefix 'NCR') — NOT in the db/07 seed,
--                        so we add it here (guarded ON CONFLICT DO NOTHING)
--   * RLS ENABLE + per-company policy FOR ALL TO erp_app (ENABLE, not FORCE: the
--     owner/superuser used by tests + migrations bypasses, exactly like 003/013/015)
--   * the composite (company_id, bu_id) FK and a List-screen index
--   * DELETE grant on the rca / capa / capa_action child tables (children may be
--     removed when an NCR is reworked — db/08 granted only SELECT/INSERT/UPDATE)
--   * the field-level audit trigger trg_audit_ncr (NOT created in db/06) — added if
--     absent, so CREATE/EDIT/DELETE on the NCR are captured in audit.audit_log
-- The base status / source CHECKs (ck_ncr_status: OPEN/RCA/CAPA/CLOSED; ck_ncr_source:
-- GRN/PRODUCTION/FAT/INSTALL/WARRANTY) ALREADY include every value the module needs,
-- so we do NOT drop/replace them. The NCR_CAPA permission + RBAC grants are in db/08.
-- company_id, row_version, is_deleted already exist on qms.ncr (db/04). The child
-- tables rca/capa/capa_action carry no company_id — they are reached only via the
-- NCR, so RLS on the parent suffices and is NOT added to the children.
-- Idempotent. Apply AFTER 005_rls_role_grants.sql (and db/00_run_all.sql).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Branch (numbering scope). company_id already exists (db/04); add only bu_id.
-- ---------------------------------------------------------------------
ALTER TABLE qms.ncr
  ADD COLUMN IF NOT EXISTS bu_id BIGINT REFERENCES mdm.business_unit(bu_id);

-- ---------------------------------------------------------------------
-- 2. NUMBERING RULE for 'NCR' — branch-scoped, prefix 'NCR', FY reset. Not present
--    in the db/07 seed, so add one rule per BE branch. Mirrors the 012 pattern;
--    guarded so re-runs are no-ops.
-- ---------------------------------------------------------------------
INSERT INTO mdm.numbering_rule (company_id, bu_id, doc_type, prefix, format_template, pad_width, reset_policy)
SELECT c.company_id, bu.bu_id, 'NCR', 'NCR', '{PREFIX}/{BRANCH}/{FY}/{SEQ}', 6, 'FY'
FROM mdm.company c
JOIN mdm.business_unit bu ON bu.company_id = c.company_id
WHERE c.company_code = 'BE'
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------
-- 3. Helpful index for the List screen filters (ix_ncr_source/project already exist
--    from db/04; add the company-scoped composite).
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ix_ncr_company_status ON qms.ncr(company_id, status);

-- ---------------------------------------------------------------------
-- 4. ROW-LEVEL SECURITY (per-company), mirroring the sales surface (003).
--    ENABLE (not FORCE) is deliberate: the table owner / superuser BYPASSES RLS,
--    so migrations + the test harness (which connect as the owner) are not
--    filtered. Enforcement applies ONLY to the non-superuser erp_app login role.
--    Scope is taken from the transaction-local GUC app.company_id. The child
--    tables rca/capa/capa_action have no company_id and are reached only via the
--    NCR, so RLS on the parent suffices — no policy is added to the children.
-- ---------------------------------------------------------------------
ALTER TABLE qms.ncr ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE qms.ncr IS
  'RLS ENABLED (not FORCE): rls_ncr_company scopes rows to app.company_id for the erp_app role only; the owner/superuser bypasses (used by tests + migrations). Failure analysis 8D lifecycle: OPEN->RCA->CAPA->CLOSED.';

DROP POLICY IF EXISTS rls_ncr_company ON qms.ncr;
CREATE POLICY rls_ncr_company ON qms.ncr
  FOR ALL TO erp_app
  USING      (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint);

-- ---------------------------------------------------------------------
-- 5. BUSINESS-UNIT / COMPANY INTEGRITY: an NCR's branch must belong to its company.
--    bu_id is nullable; MATCH SIMPLE skips the check when NULL, so a company-wide
--    (branchless) NCR still works. uq_bu_company exists from 003.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_ncr_bu_company'
      AND conrelid = 'qms.ncr'::regclass
  ) THEN
    ALTER TABLE qms.ncr
      ADD CONSTRAINT fk_ncr_bu_company
      FOREIGN KEY (company_id, bu_id)
      REFERENCES mdm.business_unit (company_id, bu_id);
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 6. AUDIT TRIGGER. db/06 does NOT attach any trigger to qms.ncr. Add the
--    field-level audit trigger trg_audit_ncr (audit.fn_audit on the PK 'ncr_id')
--    if it is not already present, so CREATE/EDIT/DELETE are captured in
--    audit.audit_log — mirroring trg_audit_dispatch (db/06) and trg_audit_ticket (015).
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_audit_ncr'
      AND tgrelid = 'qms.ncr'::regclass
  ) THEN
    CREATE TRIGGER trg_audit_ncr
      AFTER INSERT OR UPDATE OR DELETE ON qms.ncr
      FOR EACH ROW EXECUTE FUNCTION audit.fn_audit('ncr_id');
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 7. CHILD-TABLE DELETE GRANTS. The children of an NCR (root-cause analyses,
--    CAPAs, CAPA actions) may be removed when an NCR is reworked, so erp_app needs
--    DELETE on them (db/08 granted only SELECT/INSERT/UPDATE). The parent qms.ncr
--    keeps soft-delete only (no DELETE grant).
-- ---------------------------------------------------------------------
GRANT DELETE ON qms.rca, qms.capa, qms.capa_action TO erp_app;

-- End migration 016_failure_analysis.
