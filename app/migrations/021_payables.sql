-- =====================================================================
-- Module — Accounts Payable (Vendor Invoices & Payments) : incremental migration
-- Brings the base AP tables (db/05_fin_audit_rpt.sql) up to the platform's
-- branch-numbering + multi-tenant RLS + optimistic-concurrency + audit
-- conventions so the payables module can serve them through the RLS-enforced
-- erp_app role.
--
-- BASE-SCHEMA SURPRISE: unlike most module tables, fin.vendor_invoice ships in
-- db/05 with NO row_version, NO is_deleted, and NO created_*/updated_* audit
-- columns (and db/06 attaches NO audit trigger to it — only to fin.invoice). So
-- this migration ADDS all of those, mirroring how every other module's base
-- table carries them, to support optimistic concurrency + soft delete + audit.
--
-- The vendor-invoice status CHECK (ck_vinv_status: PENDING/MATCHED/APPROVED/
-- PAID/DISPUTED, db/05) already covers every state the module uses, so it is NOT
-- dropped/replaced. There is NO numbering rule for the vendor invoice — vinv_no
-- is the SUPPLIER's own invoice number, supplied by the user. Only the vendor
-- PAYMENT is numbered ('VPAY', prefix 'VPY').
--
-- The AP_INVOICE permission catalog + grants are already seeded in db/08; this
-- migration re-asserts the grants idempotently (guarded) so the module is
-- self-contained when applied against a database that predates that seed.
-- Idempotent. Apply AFTER 005_rls_role_grants.sql (and db/00_run_all.sql).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Optimistic concurrency + soft delete + audit columns on the vendor
--    invoice (db/05 ships NONE of these), plus the branch (numbering scope is
--    on the PAYMENT, but bu_id is carried for the composite-FK tenant check).
--    company_id already exists (db/05); add only the missing columns.
-- ---------------------------------------------------------------------
ALTER TABLE fin.vendor_invoice
  ADD COLUMN IF NOT EXISTS bu_id       BIGINT REFERENCES mdm.business_unit(bu_id),
  ADD COLUMN IF NOT EXISTS row_version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS is_deleted  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS created_by  BIGINT,
  ADD COLUMN IF NOT EXISTS created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_by  BIGINT,
  ADD COLUMN IF NOT EXISTS updated_at  TIMESTAMPTZ NOT NULL DEFAULT now();

-- 1b. Branch on the vendor payment (numbering scope for the 'VPAY' number).
--     company_id already exists (db/05); add only bu_id.
ALTER TABLE fin.vendor_payment
  ADD COLUMN IF NOT EXISTS bu_id BIGINT REFERENCES mdm.business_unit(bu_id);

-- ---------------------------------------------------------------------
-- 2. NUMBERING RULE for the vendor PAYMENT — branch-scoped, prefix 'VPY', FY
--    reset. Not present in the db/07 seed, so add one rule per BE branch.
--    Mirrors the db/07 / 012 / 019 pattern; guarded so re-runs are no-ops.
--    (No rule for the vendor invoice: vinv_no is user-supplied.)
-- ---------------------------------------------------------------------
INSERT INTO mdm.numbering_rule (company_id, bu_id, doc_type, prefix, format_template, pad_width, reset_policy)
SELECT c.company_id, bu.bu_id, 'VPAY', 'VPY', '{PREFIX}/{BRANCH}/{FY}/{SEQ}', 6, 'FY'
FROM mdm.company c
JOIN mdm.business_unit bu ON bu.company_id = c.company_id
WHERE c.company_code = 'BE'
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------
-- 3. Helpful indexes for the List screens.
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ix_vinv_company_status ON fin.vendor_invoice(company_id, status);
CREATE INDEX IF NOT EXISTS ix_vpay_company_vendor ON fin.vendor_payment(company_id, vendor_id);

-- ---------------------------------------------------------------------
-- 4. ROW-LEVEL SECURITY (per-company), mirroring the sales surface (003/013/019).
--    ENABLE (not FORCE) is deliberate: the table owner / superuser BYPASSES RLS,
--    so migrations + the test harness (which connect as the owner) are not
--    filtered. Enforcement applies ONLY to the non-superuser erp_app login role.
--    The repository INSERTs set company_id = ctx.companyId so new rows pass the
--    policy's WITH CHECK. fin.vendor_invoice_line has no company_id (reached only
--    via its parent), so it carries NO RLS policy.
-- ---------------------------------------------------------------------

-- 4a. Vendor invoice (fin.vendor_invoice).
ALTER TABLE fin.vendor_invoice ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE fin.vendor_invoice IS
  'RLS ENABLED (not FORCE): rls_vendor_invoice_company scopes rows to app.company_id for the erp_app role only; the owner/superuser bypasses (used by tests + migrations). AP / vendor bill (3-way match): PENDING->MATCHED->APPROVED->PAID (+DISPUTED off any non-PAID). row_version/is_deleted/audit columns added by migration 021 (absent in db/05).';

DROP POLICY IF EXISTS rls_vendor_invoice_company ON fin.vendor_invoice;
CREATE POLICY rls_vendor_invoice_company ON fin.vendor_invoice
  FOR ALL TO erp_app
  USING      (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint);

-- 4b. Vendor payment (fin.vendor_payment).
ALTER TABLE fin.vendor_payment ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE fin.vendor_payment IS
  'RLS ENABLED (not FORCE): rls_vendor_payment_company scopes rows to app.company_id for the erp_app role only; the owner/superuser bypasses (used by tests + migrations). Payments accumulate against an APPROVED vendor_invoice and flip it to PAID once fully settled.';

DROP POLICY IF EXISTS rls_vendor_payment_company ON fin.vendor_payment;
CREATE POLICY rls_vendor_payment_company ON fin.vendor_payment
  FOR ALL TO erp_app
  USING      (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint);

-- ---------------------------------------------------------------------
-- 5. BUSINESS-UNIT / COMPANY INTEGRITY: a bill's / payment's branch must belong
--    to its company. bu_id is nullable; MATCH SIMPLE skips the check when NULL.
--    uq_bu_company exists from 003. Each FK is guarded by a pg_constraint DO-block.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_vendor_invoice_bu_company'
      AND conrelid = 'fin.vendor_invoice'::regclass
  ) THEN
    ALTER TABLE fin.vendor_invoice
      ADD CONSTRAINT fk_vendor_invoice_bu_company
      FOREIGN KEY (company_id, bu_id)
      REFERENCES mdm.business_unit (company_id, bu_id) MATCH SIMPLE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_vendor_payment_bu_company'
      AND conrelid = 'fin.vendor_payment'::regclass
  ) THEN
    ALTER TABLE fin.vendor_payment
      ADD CONSTRAINT fk_vendor_payment_bu_company
      FOREIGN KEY (company_id, bu_id)
      REFERENCES mdm.business_unit (company_id, bu_id) MATCH SIMPLE;
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 6. AUDIT TRIGGER. db/06 attaches the field-level audit trigger to fin.invoice
--    but NOT to fin.vendor_invoice. Add trg_audit_vendor_invoice (audit.fn_audit
--    on the PK 'vendor_invoice_id') if it is not already present, so CREATE/EDIT/
--    DELETE are captured in audit.audit_log — EXACTLY like 015_service.sql does.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_audit_vendor_invoice'
      AND tgrelid = 'fin.vendor_invoice'::regclass
  ) THEN
    CREATE TRIGGER trg_audit_vendor_invoice
      AFTER INSERT OR UPDATE OR DELETE ON fin.vendor_invoice
      FOR EACH ROW EXECUTE FUNCTION audit.fn_audit('vendor_invoice_id');
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 7. GRANTS. The erp_app role needs SELECT/INSERT/UPDATE on the two fin tables
--    the module writes, plus DELETE on the line child (the app fully replaces a
--    bill's lines on edit). The parent fin.vendor_invoice keeps soft-delete only
--    (no DELETE grant). fin.vendor_payment is append-only from the app (no
--    UPDATE/DELETE needed beyond the invoice status flip done on fin.vendor_invoice).
-- ---------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON fin.vendor_invoice, fin.vendor_payment TO erp_app;
GRANT SELECT, INSERT ON fin.vendor_invoice_line TO erp_app;
GRANT DELETE ON fin.vendor_invoice_line TO erp_app;

-- ---------------------------------------------------------------------
-- 8. RBAC re-assert (defensive). The AP_INVOICE permission catalog + role grants
--    are already seeded in db/08. Re-assert idempotently so the module is
--    self-contained when applied against a database that predates that seed:
--      CREATE/EDIT/APPROVE/DELETE -> FINANCE
--      VIEW                       -> ADMIN, CEO, FINANCE, PURCHASE
--      EXPORT                     -> CEO, FINANCE
-- ---------------------------------------------------------------------
INSERT INTO sec.permission (perm_code, module, action, description)
SELECT 'AP_INVOICE.' || a.action, 'AP_INVOICE', a.action, a.action || ' on AP_INVOICE'
FROM (VALUES ('VIEW'),('CREATE'),('EDIT'),('DELETE'),('APPROVE'),('EXPORT')) AS a(action)
ON CONFLICT (perm_code) DO NOTHING;

INSERT INTO sec.role_permission (role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM (VALUES
    ('FINANCE','AP_INVOICE','VCEDAX'),
    ('CEO','AP_INVOICE','VX'),
    ('ADMIN','AP_INVOICE','V'),
    ('PURCHASE','AP_INVOICE','V')
) AS g(role_code, module, flags)
JOIN sec.role r ON r.role_code = g.role_code
JOIN LATERAL (VALUES ('V','VIEW'),('C','CREATE'),('E','EDIT'),('D','DELETE'),('A','APPROVE'),('X','EXPORT'))
     AS act(letter, action) ON strpos(g.flags, act.letter) > 0
JOIN sec.permission p ON p.module = g.module AND p.action = act.action
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- End migration 021_payables.
