-- =====================================================================
-- Module — Accounts Receivable / Customer Billing (Invoicing) : incremental migration
-- Brings the base AR surface (db/05_fin_audit_rpt.sql) up to the platform's
-- branch-numbering + multi-tenant RLS conventions so the billing module can serve
-- it through the RLS-enforced erp_app role:
--   * fin.invoice.bu_id   — branch, the numbering scope for the INVOICE number
--                           (company_id already exists on fin.invoice, db/05)
--   * 'INVOICE' (prefix 'INV') and 'RECEIPT' (prefix 'RCT') numbering rules —
--     NOT in the db/07 seed, so we add them here (guarded ON CONFLICT DO NOTHING)
--   * RLS ENABLE + per-company policy FOR ALL TO erp_app on fin.invoice and
--     fin.payment_receipt (ENABLE, not FORCE: the owner/superuser used by tests +
--     migrations bypasses, exactly like 003/012/013/019). The child / project-
--     scoped tables (fin.invoice_line, fin.payment_allocation, fin.advance,
--     fin.retention, fin.revenue_recognition) have no company_id and are reached
--     via their parents / project, so they carry NO RLS policy.
--   * the composite (company_id, bu_id) FK on fin.invoice + a List-screen index
--   * the child-table DELETE grants the app needs (it replaces invoice lines on
--     edit and CASCADE-replaces allocations) + the write grants on the AR tables
-- The field-level audit trigger trg_audit_invoice is ALREADY attached in db/06
-- (invoice_id); do NOT re-create it.
-- IMPORTANT: the columns irn, ack_no (and any eway_bill_no) on fin.invoice are
-- owned by the Tax module (migration 022, e-invoice / e-way bill stamping) — this
-- migration does NOT add or alter them.
-- The INVOICE permission catalog (INVOICE.{VIEW,CREATE,EDIT,DELETE,APPROVE,EXPORT})
-- and grants (FINANCE=VCEDAX; CEO=VX; ADMIN/SALES/PLANNING/SERVICE=V) are ALREADY
-- seeded in db/08; re-assert defensively below so this module is self-contained.
-- Idempotent. Apply AFTER 005_rls_role_grants.sql (and db/00_run_all.sql).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Branch (numbering scope). company_id already exists on fin.invoice (db/05);
--    add only bu_id. fin.payment_receipt is numbered company-wide (no bu_id needed
--    — next_document_no falls back to the company-wide rule when bu_id is null).
-- ---------------------------------------------------------------------
ALTER TABLE fin.invoice
  ADD COLUMN IF NOT EXISTS bu_id BIGINT REFERENCES mdm.business_unit(bu_id);

-- ---------------------------------------------------------------------
-- 2. NUMBERING RULES for 'INVOICE' (prefix 'INV') and 'RECEIPT' (prefix 'RCT') —
--    branch-scoped, FY reset. Not present in the db/07 seed, so add one rule per
--    BE branch. Mirrors the db/07 / 012 pattern; guarded so re-runs are no-ops.
-- ---------------------------------------------------------------------
INSERT INTO mdm.numbering_rule (company_id, bu_id, doc_type, prefix, format_template, pad_width, reset_policy)
SELECT c.company_id, bu.bu_id, 'INVOICE', 'INV', '{PREFIX}/{BRANCH}/{FY}/{SEQ}', 6, 'FY'
FROM mdm.company c
JOIN mdm.business_unit bu ON bu.company_id = c.company_id
WHERE c.company_code = 'BE'
ON CONFLICT DO NOTHING;

INSERT INTO mdm.numbering_rule (company_id, bu_id, doc_type, prefix, format_template, pad_width, reset_policy)
SELECT c.company_id, bu.bu_id, 'RECEIPT', 'RCT', '{PREFIX}/{BRANCH}/{FY}/{SEQ}', 6, 'FY'
FROM mdm.company c
JOIN mdm.business_unit bu ON bu.company_id = c.company_id
WHERE c.company_code = 'BE'
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------
-- 3. Helpful index for the List screen filters (ix_invoice_status on
--    (status, invoice_date) already exists from db/05; add the company-scoped
--    composite used by list()).
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ix_invoice_company_status ON fin.invoice(company_id, status);

-- ---------------------------------------------------------------------
-- 4. ROW-LEVEL SECURITY (per-company), mirroring the sales surface (003/013/019).
--    ENABLE (not FORCE) is deliberate: the table owner / superuser BYPASSES RLS,
--    so migrations + the test harness (which connect as the owner) are not
--    filtered. Enforcement applies ONLY to the non-superuser erp_app login role.
--    The repository INSERTs set company_id = ctx.companyId so new rows pass the
--    policy's WITH CHECK.
-- ---------------------------------------------------------------------

-- 4a. Customer invoice (fin.invoice).
ALTER TABLE fin.invoice ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE fin.invoice IS
  'RLS ENABLED (not FORCE): rls_invoice_company scopes rows to app.company_id for the erp_app role only; the owner/superuser bypasses (used by tests + migrations). AR customer invoice (header + fin.invoice_line). irn/ack_no are owned by the Tax module (e-invoice stamping).';

DROP POLICY IF EXISTS rls_invoice_company ON fin.invoice;
CREATE POLICY rls_invoice_company ON fin.invoice
  FOR ALL TO erp_app
  USING      (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint);

-- 4b. Customer receipt (fin.payment_receipt).
ALTER TABLE fin.payment_receipt ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE fin.payment_receipt IS
  'RLS ENABLED (not FORCE): rls_receipt_company scopes rows to app.company_id for the erp_app role only; the owner/superuser bypasses (used by tests + migrations). Customer receipt; allocations (fin.payment_allocation) CASCADE on the receipt and are reached via it.';

DROP POLICY IF EXISTS rls_receipt_company ON fin.payment_receipt;
CREATE POLICY rls_receipt_company ON fin.payment_receipt
  FOR ALL TO erp_app
  USING      (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint);

-- ---------------------------------------------------------------------
-- 5. BUSINESS-UNIT / COMPANY INTEGRITY: an invoice's branch must belong to its
--    company. bu_id is nullable; MATCH SIMPLE skips the check when NULL, so a
--    company-wide (branchless) invoice still works. uq_bu_company exists from 003.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_invoice_bu_company'
      AND conrelid = 'fin.invoice'::regclass
  ) THEN
    ALTER TABLE fin.invoice
      ADD CONSTRAINT fk_invoice_bu_company
      FOREIGN KEY (company_id, bu_id)
      REFERENCES mdm.business_unit (company_id, bu_id) MATCH SIMPLE;
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 6. GRANTS. The app fully replaces an invoice's lines when it is (re-)edited and
--    CASCADE-replaces a receipt's allocations, so erp_app needs DELETE on those
--    children (db/06 granted only SELECT/INSERT/UPDATE). The parent fin.invoice
--    keeps soft-delete only (no DELETE grant). Re-assert the SELECT/INSERT/UPDATE
--    grants on the AR tables this module writes, plus UPDATE on fin.invoice — the
--    Tax module (e-invoice stamping) also UPDATEs fin.invoice, so this grant
--    covers both writers. Base grants normally cover these; re-assert defensively.
-- ---------------------------------------------------------------------
GRANT DELETE ON fin.invoice_line, fin.payment_allocation TO erp_app;
GRANT SELECT, INSERT, UPDATE ON
  fin.invoice, fin.invoice_line, fin.payment_receipt, fin.payment_allocation,
  fin.advance, fin.retention, fin.revenue_recognition TO erp_app;
GRANT UPDATE ON fin.invoice TO erp_app;

-- ---------------------------------------------------------------------
-- 7. RBAC re-assert (defensive). The INVOICE permission catalog + role grants are
--    already seeded in db/08 (INVOICE.{VIEW,CREATE,EDIT,DELETE,APPROVE,EXPORT};
--    FINANCE=VCEDAX, CEO=VX, ADMIN/SALES/PLANNING/SERVICE=V). Re-assert idempotently
--    so the module is self-contained when applied against a database that predates
--    that seed. (The FRD's grant set — CREATE/EDIT/APPROVE/DELETE->FINANCE; VIEW->
--    ADMIN/CEO/FINANCE/PLANNING/SALES/SERVICE; EXPORT->CEO/FINANCE — is a subset.)
-- ---------------------------------------------------------------------
INSERT INTO sec.permission (perm_code, module, action, description)
SELECT 'INVOICE.' || a.action, 'INVOICE', a.action, a.action || ' on INVOICE'
FROM (VALUES ('VIEW'),('CREATE'),('EDIT'),('DELETE'),('APPROVE'),('EXPORT')) AS a(action)
ON CONFLICT (perm_code) DO NOTHING;

INSERT INTO sec.role_permission (role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM (VALUES
    ('FINANCE','INVOICE','VCEDAX'),
    ('CEO','INVOICE','VX'),
    ('ADMIN','INVOICE','V'),
    ('SALES','INVOICE','V'),
    ('PLANNING','INVOICE','V'),
    ('SERVICE','INVOICE','V')
) AS g(role_code, module, flags)
JOIN sec.role r ON r.role_code = g.role_code
JOIN LATERAL (VALUES ('V','VIEW'),('C','CREATE'),('E','EDIT'),('D','DELETE'),('A','APPROVE'),('X','EXPORT'))
     AS act(letter, action) ON strpos(g.flags, act.letter) > 0
JOIN sec.permission p ON p.module = g.module AND p.action = act.action
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- End migration 020_billing.
