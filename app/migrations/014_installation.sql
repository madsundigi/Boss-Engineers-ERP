-- =====================================================================
-- Module M12 — Installation & Commissioning : incremental migration
-- Brings the base svc.installation table (db/04_qms_log_svc.sql) up to the
-- platform's branch-numbering + multi-tenant RLS conventions so the installation
-- module can serve it through the RLS-enforced erp_app role:
--   * bu_id           — branch, required to allocate a branch-scoped INST number
--   * RLS ENABLE + per-company policy FOR ALL TO erp_app (ENABLE, not FORCE: the
--     owner/superuser used by tests + migrations bypasses, exactly like 003/013/015)
--   * the composite (company_id, bu_id) FK and a List-screen index
--   * the field-level audit trigger trg_audit_install (NOT created in db/06) —
--     added if absent, so CREATE/EDIT/DELETE are captured in audit.audit_log
--   * DELETE grant on the qms.punch_item child the app fully replaces on edit
-- The base status CHECK (ck_install_status) ALREADY covers the full lifecycle
-- PLANNED/IN_PROGRESS/COMMISSIONED/ACCEPTED/CLOSED and the SAT CHECK
-- (ck_sat_result) covers PASS/FAIL/PENDING — so neither is dropped/replaced
-- (unlike dispatch). The 'INSTALL' numbering rule (prefix 'INST') is ALREADY
-- seeded in db/07, and the INSTALLATION permission + RBAC grants in db/08 — so we
-- seed NEITHER. company_id, row_version, is_deleted already exist (db/04).
-- Idempotent. Apply AFTER 005_rls_role_grants.sql (and db/00_run_all.sql).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Branch (numbering scope). company_id already exists on svc.installation
--    (db/04); add only bu_id, idempotently. bu_id is the numbering scope.
-- ---------------------------------------------------------------------
ALTER TABLE svc.installation
  ADD COLUMN IF NOT EXISTS bu_id BIGINT REFERENCES mdm.business_unit(bu_id);

-- ---------------------------------------------------------------------
-- 2. Helpful index for the List screen filters.
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ix_install_company_status ON svc.installation(company_id, status);

-- ---------------------------------------------------------------------
-- 3. ROW-LEVEL SECURITY (per-company), mirroring the sales surface (003).
--    ENABLE (not FORCE) is deliberate: the table owner / superuser BYPASSES RLS,
--    so migrations + the test harness (which connect as the owner) are not
--    filtered. Enforcement applies ONLY to the non-superuser erp_app login role.
--    Scope is taken from the transaction-local GUC app.company_id.
-- ---------------------------------------------------------------------
ALTER TABLE svc.installation ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE svc.installation IS
  'RLS ENABLED (not FORCE): rls_installation_company scopes rows to app.company_id for the erp_app role only; the owner/superuser bypasses (used by tests + migrations). Site lifecycle: PLANNED->IN_PROGRESS->COMMISSIONED (SAT)->ACCEPTED->CLOSED; acceptance requires a PASSED SAT + zero open punch items and emits installation.accepted.';

DROP POLICY IF EXISTS rls_installation_company ON svc.installation;
CREATE POLICY rls_installation_company ON svc.installation
  FOR ALL TO erp_app
  USING      (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint);

-- ---------------------------------------------------------------------
-- 4. BUSINESS-UNIT / COMPANY INTEGRITY: an installation's branch must belong to
--    its company. bu_id is nullable; MATCH SIMPLE skips the check when NULL, so a
--    company-wide (branchless) installation still works. uq_bu_company exists
--    from 003_security_hardening.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_installation_bu_company'
      AND conrelid = 'svc.installation'::regclass
  ) THEN
    ALTER TABLE svc.installation
      ADD CONSTRAINT fk_installation_bu_company
      FOREIGN KEY (company_id, bu_id)
      REFERENCES mdm.business_unit (company_id, bu_id) MATCH SIMPLE;
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 5. AUDIT TRIGGER. db/06 attaches the field-level audit trigger to the other
--    document tables (quotation/project/dispatch/...) but NOT to svc.installation.
--    Add trg_audit_install (audit.fn_audit on the PK 'install_id') if it is not
--    already present, so CREATE/EDIT/DELETE are captured in audit.audit_log.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_audit_install'
      AND tgrelid = 'svc.installation'::regclass
  ) THEN
    CREATE TRIGGER trg_audit_install
      AFTER INSERT OR UPDATE OR DELETE ON svc.installation
      FOR EACH ROW EXECUTE FUNCTION audit.fn_audit('install_id');
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 6. CHILD-TABLE DELETE GRANT. The app fully replaces an installation's punch
--    list (the SAT/commissioning defect list) when it is (re-)edited, so erp_app
--    needs DELETE on qms.punch_item (db/06 granted only SELECT/INSERT/UPDATE).
--    The parent svc.installation keeps soft-delete only (no DELETE grant).
-- ---------------------------------------------------------------------
GRANT DELETE ON qms.punch_item TO erp_app;

-- End migration 014_installation.
