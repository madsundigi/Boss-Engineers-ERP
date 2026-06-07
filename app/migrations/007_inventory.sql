-- =====================================================================
-- Module M06 — Inventory & Critical Items : incremental migration
-- Builds on the base scm.* stock model (db/03_hcm_mfg_scm.sql):
--   scm.item_stock           — on-hand / reserved / available (project vs free)
--   scm.stock_transaction    — immutable signed ledger (ADJUST/RESERVE/ISSUE…)
--   scm.material_reservation  + reservation_line   — reserve to project/WBS
--   scm.material_issue        + material_issue_line — issue to production
--   scm.critical_item         + critical_item_alert — early-warning register
-- Adds a small stock-adjustment / write-off document (header) so receipts and
-- write-offs get an approval lifecycle + optimistic concurrency (row_version),
-- with FINANCE/INVENTORY.APPROVE gating the post of a write-off.
--
-- Idempotent. Apply AFTER the base schema (db/00_run_all.sql) and 005.
-- RLS is ENABLE (not FORCE): the owner/superuser used by migrations + the
-- integration test harness bypasses it; only the erp_app login role is scoped.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Stock adjustment / receipt / write-off document (header)
--    Inventory txns don't need gapless numbers (identity PK). A write-off
--    (qty out, adj_type='WRITE_OFF') requires INVENTORY.APPROVE before it
--    posts to stock; a RECEIPT (qty in) / ADJUST follows the same lifecycle.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scm.stock_adjustment (
    adj_id       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id   BIGINT NOT NULL REFERENCES mdm.company(company_id),
    item_id      BIGINT NOT NULL REFERENCES mdm.item(item_id),
    warehouse_id BIGINT NOT NULL REFERENCES mdm.warehouse(warehouse_id),
    project_id   BIGINT REFERENCES proj.project(project_id),
    adj_type     VARCHAR(15) NOT NULL DEFAULT 'RECEIPT',
    qty          NUMERIC(20,4) NOT NULL,        -- always positive; sign comes from adj_type
    unit_cost    NUMERIC(20,6) NOT NULL DEFAULT 0,
    reason       VARCHAR(300),
    status       VARCHAR(15) NOT NULL DEFAULT 'DRAFT',
    approved_by  BIGINT REFERENCES sec.app_user(user_id),
    approved_at  TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by   BIGINT REFERENCES sec.app_user(user_id),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by   BIGINT REFERENCES sec.app_user(user_id),
    row_version  INT NOT NULL DEFAULT 1,
    is_deleted   BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT ck_stock_adj_type   CHECK (adj_type IN ('RECEIPT','WRITE_OFF','ADJUST')),
    CONSTRAINT ck_stock_adj_status CHECK (status IN ('DRAFT','APPROVED','POSTED','REJECTED','CANCELLED')),
    CONSTRAINT ck_stock_adj_qty    CHECK (qty > 0)
);
CREATE INDEX IF NOT EXISTS ix_stock_adj_company ON scm.stock_adjustment(company_id, status);
CREATE INDEX IF NOT EXISTS ix_stock_adj_item    ON scm.stock_adjustment(item_id);

-- ---------------------------------------------------------------------
-- 2. company_id integrity on the stock table (base already has it; this is
--    a defensive guard so the RLS policy below always has a column to scope).
-- ---------------------------------------------------------------------
ALTER TABLE scm.item_stock
  ADD COLUMN IF NOT EXISTS company_id BIGINT REFERENCES mdm.company(company_id);

-- ---------------------------------------------------------------------
-- 3. ROW-LEVEL SECURITY — scope stock + adjustments to app.company_id.
--    ENABLE (not FORCE): erp_app is filtered; owner/superuser bypasses so
--    migrations + test fixtures still see their rows.
-- ---------------------------------------------------------------------
ALTER TABLE scm.item_stock       ENABLE ROW LEVEL SECURITY;
ALTER TABLE scm.stock_adjustment ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE scm.item_stock IS
  'RLS ENABLED (not FORCE): rls_item_stock_company scopes rows to app.company_id for the erp_app role only; the owner/superuser bypasses (used by tests + migrations).';
COMMENT ON TABLE scm.stock_adjustment IS
  'RLS ENABLED (not FORCE): rls_stock_adjustment_company scopes rows to app.company_id for the erp_app role only; the owner/superuser bypasses (used by tests + migrations).';

DROP POLICY IF EXISTS rls_item_stock_company ON scm.item_stock;
CREATE POLICY rls_item_stock_company ON scm.item_stock
  FOR ALL TO erp_app
  USING      (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint);

DROP POLICY IF EXISTS rls_stock_adjustment_company ON scm.stock_adjustment;
CREATE POLICY rls_stock_adjustment_company ON scm.stock_adjustment
  FOR ALL TO erp_app
  USING      (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint);

-- ---------------------------------------------------------------------
-- 4. Audit triggers (reuse the canonical audit.fn_audit('<pk_col>') from db/09).
--    item_stock is the main mutable balance table; stock_adjustment + the
--    issue/reservation documents are append-only intent records.
-- ---------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_audit_item_stock ON scm.item_stock;
CREATE TRIGGER trg_audit_item_stock
  AFTER INSERT OR UPDATE OR DELETE ON scm.item_stock
  FOR EACH ROW EXECUTE FUNCTION audit.fn_audit('stock_id');

DROP TRIGGER IF EXISTS trg_audit_stock_adjustment ON scm.stock_adjustment;
CREATE TRIGGER trg_audit_stock_adjustment
  AFTER INSERT OR UPDATE OR DELETE ON scm.stock_adjustment
  FOR EACH ROW EXECUTE FUNCTION audit.fn_audit('adj_id');

DROP TRIGGER IF EXISTS trg_audit_material_issue ON scm.material_issue;
CREATE TRIGGER trg_audit_material_issue
  AFTER INSERT OR UPDATE OR DELETE ON scm.material_issue
  FOR EACH ROW EXECUTE FUNCTION audit.fn_audit('issue_id');

DROP TRIGGER IF EXISTS trg_audit_material_reservation ON scm.material_reservation;
CREATE TRIGGER trg_audit_material_reservation
  AFTER INSERT OR UPDATE OR DELETE ON scm.material_reservation
  FOR EACH ROW EXECUTE FUNCTION audit.fn_audit('reservation_id');

-- ---------------------------------------------------------------------
-- 5. Material-issue numbering (no gapless rule needed; a per-DB sequence
--    yields a unique, human-readable issue_no without mdm.next_document_no).
-- ---------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS scm.seq_material_issue_no;
GRANT USAGE, SELECT ON SEQUENCE scm.seq_material_issue_no TO erp_app;

-- ---------------------------------------------------------------------
-- 6. Helpful indexes for the List / critical-item screens.
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ix_stock_company_item ON scm.item_stock(company_id, item_id);

-- ---------------------------------------------------------------------
-- 7. Grants. erp_app already holds SELECT/INSERT/UPDATE on all scm tables
--    (db/06). The new stock_adjustment table is covered by ALTER DEFAULT
--    PRIVILEGES, but grant explicitly to be safe + future-proof. No DELETE is
--    granted: documents are soft-deleted (is_deleted), never hard-deleted.
-- ---------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON scm.stock_adjustment TO erp_app;

-- End migration 007_inventory.
