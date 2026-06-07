-- =====================================================================
-- Module M13 — Warranty & Service : incremental migration
-- Brings the base svc.service_ticket family (db/04_qms_log_svc.sql) up to the
-- platform's branch-numbering + multi-tenant RLS conventions so the service
-- module can serve them through the RLS-enforced erp_app role:
--   * bu_id                — branch, required to allocate a branch-scoped TKT number
--   * assigned_engineer_id — the field engineer allocated to the ticket
--   * status lifecycle     — REPLACE the base CHECK (ck_ticket_status: OPEN/ASSIGNED/
--                            ON_SITE/RESOLVED/CLOSED) with the break-fix lifecycle
--                            OPEN -> ASSIGNED -> IN_PROGRESS -> RESOLVED -> CLOSED
--                            (+ CANCELLED), default OPEN. The base CHECK does NOT
--                            include IN_PROGRESS/CANCELLED, so without this widening
--                            the move to IN_PROGRESS would fail with a 23514 check
--                            violation (surfacing as a 400) — hence the DROP+ADD.
--   * RLS ENABLE + per-company policy FOR ALL TO erp_app (ENABLE, not FORCE: the
--     owner/superuser used by tests + migrations bypasses, exactly like 003/012/013)
--   * the composite (company_id, bu_id) FK and a List-screen index
--   * DELETE grant on the field_visit / spare_issue child tables the app replaces
--   * the field-level audit trigger trg_audit_ticket (NOT created in db/06 — only
--     the status-history trigger trg_status_ticket is) — added if absent
-- The 'SERVICE_TICKET' numbering rule (prefix 'TKT') is ALREADY seeded in db/07,
-- and the SERVICE_TICKET permission + RBAC grants in db/08 — so we seed NEITHER.
-- company_id, row_version, is_deleted already exist on svc.service_ticket (db/04).
-- Idempotent. Apply AFTER 005_rls_role_grants.sql (and db/00_run_all.sql).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Branch (numbering scope) + assigned engineer. company_id already exists
--    (db/04); add only the new columns, idempotently.
-- ---------------------------------------------------------------------
ALTER TABLE svc.service_ticket
  ADD COLUMN IF NOT EXISTS bu_id                BIGINT REFERENCES mdm.business_unit(bu_id),
  ADD COLUMN IF NOT EXISTS assigned_engineer_id BIGINT REFERENCES hcm.employee(employee_id);

-- ---------------------------------------------------------------------
-- 2. Lifecycle: OPEN -> ASSIGNED -> IN_PROGRESS -> RESOLVED -> CLOSED (+ CANCELLED).
--    Replace the base CHECK (ck_ticket_status: OPEN/ASSIGNED/ON_SITE/RESOLVED/
--    CLOSED, db/04). Migrate any legacy ON_SITE rows to IN_PROGRESS so the new
--    CHECK can attach, then move the default to OPEN.
-- ---------------------------------------------------------------------
ALTER TABLE svc.service_ticket DROP CONSTRAINT IF EXISTS ck_ticket_status;
UPDATE svc.service_ticket SET status = 'IN_PROGRESS' WHERE status = 'ON_SITE';
ALTER TABLE svc.service_ticket ALTER COLUMN status SET DEFAULT 'OPEN';
ALTER TABLE svc.service_ticket ADD CONSTRAINT ck_ticket_status
  CHECK (status IN ('OPEN','ASSIGNED','IN_PROGRESS','RESOLVED','CLOSED','CANCELLED'));

-- ---------------------------------------------------------------------
-- 3. Helpful index for the List screen filters (ix_ticket_status already exists
--    from db/04; add the company-scoped composite).
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ix_ticket_company_status ON svc.service_ticket(company_id, status);

-- ---------------------------------------------------------------------
-- 4. ROW-LEVEL SECURITY (per-company), mirroring the sales surface (003).
--    ENABLE (not FORCE) is deliberate: the table owner / superuser BYPASSES RLS,
--    so migrations + the test harness (which connect as the owner) are not
--    filtered. Enforcement applies ONLY to the non-superuser erp_app login role.
--    Scope is taken from the transaction-local GUC app.company_id.
-- ---------------------------------------------------------------------
ALTER TABLE svc.service_ticket ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE svc.service_ticket IS
  'RLS ENABLED (not FORCE): rls_service_ticket_company scopes rows to app.company_id for the erp_app role only; the owner/superuser bypasses (used by tests + migrations). Break-fix lifecycle: OPEN->ASSIGNED->IN_PROGRESS->RESOLVED->CLOSED (+CANCELLED).';

DROP POLICY IF EXISTS rls_service_ticket_company ON svc.service_ticket;
CREATE POLICY rls_service_ticket_company ON svc.service_ticket
  FOR ALL TO erp_app
  USING      (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint);

-- ---------------------------------------------------------------------
-- 5. BUSINESS-UNIT / COMPANY INTEGRITY: a ticket's branch must belong to its
--    company. bu_id is nullable; MATCH SIMPLE skips the check when NULL, so a
--    company-wide (branchless) ticket still works. uq_bu_company exists from 003.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_ticket_bu_company'
      AND conrelid = 'svc.service_ticket'::regclass
  ) THEN
    ALTER TABLE svc.service_ticket
      ADD CONSTRAINT fk_ticket_bu_company
      FOREIGN KEY (company_id, bu_id)
      REFERENCES mdm.business_unit (company_id, bu_id);
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 6. AUDIT TRIGGER. db/06 attaches only the STATUS-HISTORY trigger
--    (trg_status_ticket) to svc.service_ticket — NOT the field-level audit
--    trigger. Add trg_audit_ticket (audit.fn_audit on the PK 'ticket_id') if it
--    is not already present, so CREATE/EDIT/DELETE are captured in audit.audit_log.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_audit_ticket'
      AND tgrelid = 'svc.service_ticket'::regclass
  ) THEN
    CREATE TRIGGER trg_audit_ticket
      AFTER INSERT OR UPDATE OR DELETE ON svc.service_ticket
      FOR EACH ROW EXECUTE FUNCTION audit.fn_audit('ticket_id');
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 7. CHILD-TABLE DELETE GRANTS. The app fully replaces a ticket's field visits
--    and spare-issue lines when they are (re-)edited, so erp_app needs DELETE on
--    these children (db/06 granted only SELECT/INSERT/UPDATE). The parent
--    svc.service_ticket keeps soft-delete only (no DELETE grant). The app also
--    writes svc.warranty_claim on approval — grant INSERT defensively (the base
--    schema-wide grant normally covers it).
-- ---------------------------------------------------------------------
GRANT DELETE ON svc.field_visit, svc.spare_issue TO erp_app;
GRANT SELECT, INSERT, UPDATE ON svc.warranty_claim TO erp_app;

-- End migration 015_service.
