-- =====================================================================
-- Module — GST / Tax : incremental migration
-- Brings the GST surface up to the platform's multi-tenant RLS + grant
-- conventions so the Tax module can serve it through the RLS-enforced erp_app
-- role, and adds the one fin.invoice column e-way billing needs:
--   * fin.invoice.eway_bill_no — the ONLY change this module makes to fin.invoice
--     (irn + ack_no already exist, db/05). The AR Billing module (migration 020,
--     which runs BEFORE this) owns fin.invoice: it adds bu_id, ENABLEs RLS, creates
--     the rls_invoice_company policy, and grants UPDATE on fin.invoice to erp_app.
--     So here we DO NOT add bu_id, DO NOT enable RLS, and DO NOT create any policy
--     on fin.invoice. Our UPDATEs (setting irn/ack_no/eway_bill_no) run as erp_app
--     and satisfy Billing's company policy because company_id is never changed.
--   * RLS ENABLE + per-company policy FOR ALL TO erp_app on fin.tax_transaction
--     (ENABLE, not FORCE: the owner/superuser used by tests + migrations bypasses,
--     exactly like 003/013/019). The repository INSERT sets company_id = ctx so
--     new ledger rows pass the policy's WITH CHECK. fin.tax_transaction is
--     APPEND-ONLY (insert + select; no update/delete is wanted).
--   * mdm.tax_code is a GLOBAL GST-rate master (NO company_id) — it gets NO RLS.
--     Its UNIQUE(code) already exists from db/01, so no index is added here.
--   * a composite index on the ledger for the List/summary filters.
--   * defensive SELECT/INSERT/UPDATE grants for erp_app.
-- The TAX permission catalog (TAX.{VIEW,CREATE,EDIT,DELETE,APPROVE,EXPORT}) and the
-- grants (FINANCE=VCEDAX, CEO=VX, ADMIN=V) are ALREADY seeded in db/08; re-assert
-- defensively below so this module is self-contained, guarded so re-runs are no-ops.
-- Idempotent. Apply AFTER 005_rls_role_grants.sql and AR Billing's 020 (db/00_run_all.sql).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. fin.invoice — add the e-way bill number ONLY (see header). irn + ack_no
--    already exist (db/05). Billing's migration 020 owns bu_id / RLS / policy.
-- ---------------------------------------------------------------------
ALTER TABLE fin.invoice ADD COLUMN IF NOT EXISTS eway_bill_no VARCHAR(30);

-- ---------------------------------------------------------------------
-- 2. ROW-LEVEL SECURITY (per-company) on the GST ledger, mirroring the sales
--    surface (003/013). ENABLE (not FORCE) so the table owner / superuser used by
--    migrations + the test harness BYPASSES it; enforcement applies ONLY to the
--    non-superuser erp_app login role. The repository INSERT sets
--    company_id = ctx.companyId so new rows pass the WITH CHECK.
-- ---------------------------------------------------------------------
ALTER TABLE fin.tax_transaction ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE fin.tax_transaction IS
  'RLS ENABLED (not FORCE): rls_tax_txn_company scopes rows to app.company_id for the erp_app role only; the owner/superuser bypasses (used by tests + migrations). APPEND-ONLY GST output-tax ledger (one immutable row per taxed document; corrections are new rows).';

DROP POLICY IF EXISTS rls_tax_txn_company ON fin.tax_transaction;
CREATE POLICY rls_tax_txn_company ON fin.tax_transaction
  FOR ALL TO erp_app
  USING      (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint);

-- ---------------------------------------------------------------------
-- 3. Helpful composite index for the GST register List filters + the period
--    summary (company + doc_type + date). db/05 already has ix_tax_doc
--    (doc_type, doc_id) and ix_tax_date (txn_date); this adds the company-scoped
--    composite under a distinct, guarded name. mdm.tax_code(code) is already
--    UNIQUE (db/01), so no tax-code index is created here.
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ix_tax_txn_company_type_date
  ON fin.tax_transaction(company_id, doc_type, txn_date);

-- ---------------------------------------------------------------------
-- 4. GRANTS. erp_app needs SELECT/INSERT/UPDATE on the GST rate master (CRUD +
--    setActive) and SELECT/INSERT on the append-only GST ledger (no UPDATE/DELETE
--    wanted there). UPDATE on fin.invoice is granted by Billing's migration 020;
--    re-grant defensively (a redundant GRANT is harmless) so the e-invoice / e-way
--    stamps work even if applied standalone.
-- ---------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON mdm.tax_code TO erp_app;
GRANT SELECT, INSERT ON fin.tax_transaction TO erp_app;
GRANT UPDATE ON fin.invoice TO erp_app;

-- ---------------------------------------------------------------------
-- 5. RBAC re-assert (defensive). The TAX permission catalog + role grants are
--    already seeded in db/08 (TAX.{VIEW,CREATE,EDIT,DELETE,APPROVE,EXPORT};
--    FINANCE=VCEDAX, CEO=VX, ADMIN=V). Re-assert idempotently so the module is
--    self-contained when applied against a database that predates that seed.
-- ---------------------------------------------------------------------
INSERT INTO sec.permission (perm_code, module, action, description)
SELECT 'TAX.' || a.action, 'TAX', a.action, a.action || ' on TAX'
FROM (VALUES ('VIEW'),('CREATE'),('EDIT'),('DELETE'),('APPROVE'),('EXPORT')) AS a(action)
ON CONFLICT (perm_code) DO NOTHING;

INSERT INTO sec.role_permission (role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM (VALUES
    ('CEO','TAX','VX'), ('ADMIN','TAX','V'), ('FINANCE','TAX','VCEDAX')
) AS g(role_code, module, flags)
JOIN sec.role r ON r.role_code = g.role_code
JOIN LATERAL (VALUES ('V','VIEW'),('C','CREATE'),('E','EDIT'),('D','DELETE'),('A','APPROVE'),('X','EXPORT'))
     AS act(letter, action) ON strpos(g.flags, act.letter) > 0
JOIN sec.permission p ON p.module = g.module AND p.action = act.action
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- End migration 022_tax.
