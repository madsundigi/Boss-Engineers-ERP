-- =====================================================================
-- Module — Subcontracting / Job-Work (Tier-2 gap) : incremental migration
-- Turns the bare base scm.subcontract_* model (db/03_hcm_mfg_scm.sql) into a
-- managed job-work document: issue raw material to a vendor, track WIP at the
-- vendor, receive the processed goods back, then close.
--   scm.subcontract_order   (header)  — the job-work order against a vendor
--   scm.subcontract_issue   (children) — material sent out to the vendor
--   scm.subcontract_receipt (children) — processed goods received back
--
-- The base header lacks the columns every other document carries, so this
-- migration ADDS bu_id (numbering scope) + the audit/concurrency columns
-- (created/updated/row_version/is_deleted), widens the status CHECK to the new
-- lifecycle (adds ISSUED + CANCELLED), seeds the 'SUBCONTRACT' RBAC domain
-- (absent from db/08) + the 'SUBCON' numbering rule (prefix 'SC', absent from
-- db/07), enables per-company Row-Level Security on the header, adds the
-- composite (company_id, bu_id) FK, attaches the canonical audit trigger
-- (db/06 has none for these tables), and grants erp_app the DML it needs.
--
-- Idempotent. Apply AFTER the base schema (db/00_run_all.sql) and migration 027.
-- RLS is ENABLE (not FORCE): the owner/superuser used by migrations + the
-- integration test harness bypasses it; only the erp_app login role is scoped.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. RBAC — seed the 'SUBCONTRACT' permission domain (db/08 has no such module)
--    and grant it to roles. PURCHASE owns the document (full lifecycle),
--    STORES issues/receives material (VCE), and PRODUCTION/FINANCE/ADMIN read,
--    CEO reads + exports. perm_code is 'SUBCONTRACT.<ACTION>'.
-- ---------------------------------------------------------------------
INSERT INTO sec.permission (perm_code, module, action, description)
SELECT 'SUBCONTRACT.'||a, 'SUBCONTRACT', a, a||' on SUBCONTRACT'
FROM (VALUES ('VIEW'),('CREATE'),('EDIT'),('DELETE'),('APPROVE'),('EXPORT')) v(a)
ON CONFLICT (perm_code) DO NOTHING;

INSERT INTO sec.role_permission (role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM (VALUES
    ('PURCHASE','VCEDAX'), ('STORES','VCE'), ('PRODUCTION','V'),
    ('FINANCE','V'), ('ADMIN','V'), ('CEO','VX')
) g(role_code, flags)
JOIN sec.role r ON r.role_code = g.role_code
JOIN LATERAL (VALUES
    ('V','VIEW'), ('C','CREATE'), ('E','EDIT'),
    ('D','DELETE'), ('A','APPROVE'), ('X','EXPORT')
) f(letter, action) ON position(f.letter in g.flags) > 0
JOIN sec.permission p ON p.module = 'SUBCONTRACT' AND p.action = f.action
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------
-- 2. Header columns the base table is missing. bu_id is the numbering scope;
--    the audit/concurrency columns mirror every other document (db/04 pattern).
--    company_id already exists on scm.subcontract_order (db/03); add defensively.
-- ---------------------------------------------------------------------
ALTER TABLE scm.subcontract_order
  ADD COLUMN IF NOT EXISTS company_id  BIGINT REFERENCES mdm.company(company_id),
  ADD COLUMN IF NOT EXISTS bu_id       BIGINT REFERENCES mdm.business_unit(bu_id),
  ADD COLUMN IF NOT EXISTS created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS created_by  BIGINT REFERENCES sec.app_user(user_id),
  ADD COLUMN IF NOT EXISTS updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_by  BIGINT REFERENCES sec.app_user(user_id),
  ADD COLUMN IF NOT EXISTS row_version INT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS is_deleted  BOOLEAN NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------
-- 3. Lifecycle: OPEN -> ISSUED -> RECEIVED -> CLOSED (+ CANCELLED).
--    The base CHECK (db/03) is OPEN/MATERIAL_ISSUED/RECEIVED/CLOSED; replace it
--    so ISSUED + CANCELLED are allowed. Migrate any legacy MATERIAL_ISSUED rows
--    to ISSUED first so the new CHECK can attach. Default stays OPEN.
-- ---------------------------------------------------------------------
ALTER TABLE scm.subcontract_order DROP CONSTRAINT IF EXISTS ck_sco_status;
UPDATE scm.subcontract_order SET status = 'ISSUED'
  WHERE status = 'MATERIAL_ISSUED';
ALTER TABLE scm.subcontract_order ALTER COLUMN status SET DEFAULT 'OPEN';
ALTER TABLE scm.subcontract_order ADD CONSTRAINT ck_sco_status
  CHECK (status IN ('OPEN','ISSUED','RECEIVED','CLOSED','CANCELLED'));

-- ---------------------------------------------------------------------
-- 4. Numbering rule for 'SUBCON' — branch-scoped, prefix 'SC', FY reset. Not in
--    the db/07 seed, so add one rule per BE branch. Mirrors the db/07 pattern;
--    guarded so re-runs are no-ops. mdm.next_document_no(company,bu,'SUBCON')
--    yields e.g. SC/MUM/2026-27/000001.
-- ---------------------------------------------------------------------
INSERT INTO mdm.numbering_rule (company_id, bu_id, doc_type, prefix, format_template, pad_width, reset_policy)
SELECT c.company_id, bu.bu_id, 'SUBCON', 'SC', '{PREFIX}/{BRANCH}/{FY}/{SEQ}', 6, 'FY'
FROM mdm.company c
JOIN mdm.business_unit bu ON bu.company_id = c.company_id
WHERE c.company_code = 'BE'
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------
-- 5. Helpful index for the List screen filters.
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ix_subcontract_company_status
  ON scm.subcontract_order(company_id, status);

-- ---------------------------------------------------------------------
-- 6. ROW-LEVEL SECURITY (per-company) on the header. ENABLE (not FORCE): the
--    table owner / superuser BYPASSES RLS, so migrations + the test harness are
--    not filtered; enforcement applies ONLY to the non-superuser erp_app login
--    role. The issue/receipt children are always reached via the parent header
--    (no direct query path), so they carry no company_id and need no policy.
-- ---------------------------------------------------------------------
ALTER TABLE scm.subcontract_order ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE scm.subcontract_order IS
  'RLS ENABLED (not FORCE): rls_subcontract_company scopes rows to app.company_id for the erp_app role only; the owner/superuser bypasses (used by tests + migrations). Job-work lifecycle: OPEN -> ISSUED -> RECEIVED -> CLOSED (+ CANCELLED).';

DROP POLICY IF EXISTS rls_subcontract_company ON scm.subcontract_order;
CREATE POLICY rls_subcontract_company ON scm.subcontract_order
  FOR ALL TO erp_app
  USING      (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint);

-- ---------------------------------------------------------------------
-- 7. BUSINESS-UNIT / COMPANY INTEGRITY: a subcontract order's branch must belong
--    to its company. bu_id is nullable; MATCH SIMPLE skips the check when NULL,
--    so a company-wide (branchless) order still works. uq_bu_company exists from
--    003. Guarded via pg_constraint so re-runs are no-ops.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_subcontract_bu_company'
      AND conrelid = 'scm.subcontract_order'::regclass
  ) THEN
    ALTER TABLE scm.subcontract_order
      ADD CONSTRAINT fk_subcontract_bu_company
      FOREIGN KEY (company_id, bu_id)
      REFERENCES mdm.business_unit (company_id, bu_id);
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 8. AUDIT TRIGGER. db/06 attaches trg_audit_* to the high-value documents but
--    NOT to scm.subcontract_order — add it here (canonical audit.fn_audit, keyed
--    on the pk sco_id) so every CREATE/EDIT/DELETE is attributed. Guarded on
--    pg_trigger so re-runs are no-ops.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_audit_subcontract_order'
      AND tgrelid = 'scm.subcontract_order'::regclass
  ) THEN
    CREATE TRIGGER trg_audit_subcontract_order
      AFTER INSERT OR UPDATE OR DELETE ON scm.subcontract_order
      FOR EACH ROW EXECUTE FUNCTION audit.fn_audit('sco_id');
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 9. Grants. erp_app needs SELECT/INSERT/UPDATE on all three tables (header is
--    soft-delete only). The app fully (re-)inserts issue + receipt children, so
--    additionally grant DELETE on those two child tables (least privilege keeps
--    the header DELETE-free). Base db/06 grants normally cover scm.* but re-state
--    here so the module is self-contained.
-- ---------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON
    scm.subcontract_order,
    scm.subcontract_issue,
    scm.subcontract_receipt
TO erp_app;
GRANT DELETE ON scm.subcontract_issue, scm.subcontract_receipt TO erp_app;

-- End migration 028_subcontract.
