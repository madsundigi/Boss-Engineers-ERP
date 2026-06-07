-- =====================================================================
-- Module M05 — Procurement (PR / PO / GRN) : incremental migration
-- Builds on the base scm.* procurement model (db/03_hcm_mfg_scm.sql):
--   scm.purchase_requisition + pr_line   — requisition (item / qty / need-by)
--   scm.purchase_order        + po_line  — order to an approved vendor (committed cost)
--   scm.goods_receipt         + grn_line — receipt against a PO (qty received)
--
-- Adds the bu_id needed for branch-scoped numbering ({BRANCH} token in the
-- 'PR'/'PO'/'GRN' rules seeded in db/07), enables per-company Row-Level Security,
-- attaches the canonical audit trigger to PR + GRN (scm.purchase_order already
-- has trg_audit_po + trg_status_po from db/06 — not re-added), and grants the
-- erp_app role DELETE on the line child tables the app fully replaces.
--
-- Idempotent. Apply AFTER the base schema (db/00_run_all.sql) and 010.
-- RLS is ENABLE (not FORCE): the owner/superuser used by migrations + the
-- integration test harness bypasses it; only the erp_app login role is scoped.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. bu_id for branch-scoped document numbering (mdm.next_document_no
--    uses the bu's {BRANCH} token). company_id already exists on all three
--    base tables; add it defensively so the RLS policy always has a column.
-- ---------------------------------------------------------------------
ALTER TABLE scm.purchase_requisition
  ADD COLUMN IF NOT EXISTS bu_id      BIGINT REFERENCES mdm.business_unit(bu_id),
  ADD COLUMN IF NOT EXISTS company_id BIGINT REFERENCES mdm.company(company_id);

ALTER TABLE scm.purchase_order
  ADD COLUMN IF NOT EXISTS bu_id      BIGINT REFERENCES mdm.business_unit(bu_id),
  ADD COLUMN IF NOT EXISTS company_id BIGINT REFERENCES mdm.company(company_id);

ALTER TABLE scm.goods_receipt
  ADD COLUMN IF NOT EXISTS bu_id      BIGINT REFERENCES mdm.business_unit(bu_id),
  ADD COLUMN IF NOT EXISTS company_id BIGINT REFERENCES mdm.company(company_id);

-- ---------------------------------------------------------------------
-- 2. ROW-LEVEL SECURITY — scope PR / PO / GRN to app.company_id.
--    ENABLE (not FORCE): erp_app is filtered; owner/superuser bypasses so
--    migrations + test fixtures still see their rows.
-- ---------------------------------------------------------------------
ALTER TABLE scm.purchase_requisition ENABLE ROW LEVEL SECURITY;
ALTER TABLE scm.purchase_order       ENABLE ROW LEVEL SECURITY;
ALTER TABLE scm.goods_receipt        ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE scm.purchase_requisition IS
  'RLS ENABLED (not FORCE): rls_pr_company scopes rows to app.company_id for the erp_app role only; the owner/superuser bypasses (used by tests + migrations).';
COMMENT ON TABLE scm.purchase_order IS
  'RLS ENABLED (not FORCE): rls_po_company scopes rows to app.company_id for the erp_app role only; the owner/superuser bypasses (used by tests + migrations).';
COMMENT ON TABLE scm.goods_receipt IS
  'RLS ENABLED (not FORCE): rls_grn_company scopes rows to app.company_id for the erp_app role only; the owner/superuser bypasses (used by tests + migrations).';

DROP POLICY IF EXISTS rls_pr_company ON scm.purchase_requisition;
CREATE POLICY rls_pr_company ON scm.purchase_requisition
  FOR ALL TO erp_app
  USING      (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint);

DROP POLICY IF EXISTS rls_po_company ON scm.purchase_order;
CREATE POLICY rls_po_company ON scm.purchase_order
  FOR ALL TO erp_app
  USING      (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint);

DROP POLICY IF EXISTS rls_grn_company ON scm.goods_receipt;
CREATE POLICY rls_grn_company ON scm.goods_receipt
  FOR ALL TO erp_app
  USING      (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint);

-- ---------------------------------------------------------------------
-- 3. Audit triggers (reuse the canonical audit.fn_audit('<pk_col>') from db/09).
--    scm.purchase_order ALREADY has trg_audit_po (db/06) — do NOT re-add it.
--    PR + GRN get one here so all three documents are attributed.
-- ---------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_audit_purchase_requisition ON scm.purchase_requisition;
CREATE TRIGGER trg_audit_purchase_requisition
  AFTER INSERT OR UPDATE OR DELETE ON scm.purchase_requisition
  FOR EACH ROW EXECUTE FUNCTION audit.fn_audit('pr_id');

DROP TRIGGER IF EXISTS trg_audit_goods_receipt ON scm.goods_receipt;
CREATE TRIGGER trg_audit_goods_receipt
  AFTER INSERT OR UPDATE OR DELETE ON scm.goods_receipt
  FOR EACH ROW EXECUTE FUNCTION audit.fn_audit('grn_id');

-- ---------------------------------------------------------------------
-- 4. Grants. erp_app already holds SELECT/INSERT/UPDATE on all scm tables
--    (db/06). The app fully replaces line children on edit, so grant DELETE
--    on the line child tables (parents stay soft-delete only — least
--    privilege preserved on the documents themselves).
-- ---------------------------------------------------------------------
GRANT DELETE ON
    scm.pr_line,
    scm.po_line,
    scm.grn_line
TO erp_app;

-- ---------------------------------------------------------------------
-- 5. Helpful indexes for the List screens (company + status).
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ix_pr_company_status  ON scm.purchase_requisition(company_id, status);
CREATE INDEX IF NOT EXISTS ix_po_company_status  ON scm.purchase_order(company_id, status);
CREATE INDEX IF NOT EXISTS ix_grn_company_status ON scm.goods_receipt(company_id, status);

-- End migration 011_procurement.
