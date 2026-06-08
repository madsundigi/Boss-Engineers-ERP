-- =====================================================================
-- Tier-3 — Spares Catalog & Service Inventory : new module
-- The after-sales spare-part master + its per-location stock, supporting the
-- Warranty & Service module (M13, which already consumes spares via svc.spare_issue
-- on a ticket). The base model has NO catalog table for the spare part itself nor a
-- per-location on-hand balance, so this migration CREATES the two tables:
--   svc.spare_part   (catalog) — one row per orderable spare, unique part_code/company
--   svc.spare_stock  (children) — its on-hand quantity per stocking location
--
-- It seeds the 'SPARE' RBAC domain (absent from db/08), enables per-company Row-Level
-- Security on the catalog header, adds the audit trigger (db/06 has none for these
-- new tables), and grants erp_app the DML it needs. svc.spare_issue (db/04) is the
-- per-ticket consumption record and is NOT touched here.
--
-- Idempotent. Apply AFTER the base schema (db/00_run_all.sql) and migration 031.
-- RLS is ENABLE (not FORCE): the owner/superuser used by migrations + the
-- integration test harness bypasses it; only the erp_app login role is scoped.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. RBAC — seed the 'SPARE' permission domain (db/08 has no such module) and
--    grant it to roles (flag-letter idiom, db/08 / 031). SERVICE owns the catalog
--    + stock (VCEDAX), STORES maintains it (VCE), PURCHASE replenishes (VC), ADMIN
--    holds all six (VCEDAX), CEO views + exports (VX), FINANCE reads (V). perm_code
--    is 'SPARE.<ACTION>'.
-- ---------------------------------------------------------------------
INSERT INTO sec.permission (perm_code, module, action, description)
SELECT 'SPARE.' || a, 'SPARE', a, a || ' on SPARE'
FROM (VALUES ('VIEW'),('CREATE'),('EDIT'),('DELETE'),('APPROVE'),('EXPORT')) v(a)
ON CONFLICT (perm_code) DO NOTHING;

INSERT INTO sec.role_permission (role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM (VALUES
    ('SERVICE','VCEDAX'),('STORES','VCE'),('PURCHASE','VC'),
    ('ADMIN','VCEDAX'),('CEO','VX'),('FINANCE','V')
  ) g(role_code, flags)
JOIN sec.role r ON r.role_code = g.role_code
JOIN LATERAL (VALUES ('V','VIEW'),('C','CREATE'),('E','EDIT'),('D','DELETE'),('A','APPROVE'),('X','EXPORT')) f(letter, action)
  ON position(f.letter in g.flags) > 0
JOIN sec.permission p ON p.module = 'SPARE' AND p.action = f.action
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------
-- 2. TABLES. The spare-part catalog header + its per-location stock. bigint-
--    identity PKs + the canonical audit/concurrency columns on the catalog
--    (mirrors db/05 / 031). part_code is the user-supplied code; unique
--    (company_id, part_code) keeps it unique within a tenant. Money/quantity
--    columns are NUMERIC(20,4). The stock child carries no company_id: it is
--    always reached via its parent spare (no direct query path) and inherits the
--    parent's tenant, so it needs no RLS policy of its own.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS svc.spare_part (
  spare_id      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id    BIGINT NOT NULL REFERENCES mdm.company(company_id),
  part_code     VARCHAR(30) NOT NULL,
  part_name     VARCHAR(200) NOT NULL,
  uom           VARCHAR(10),
  item_id       BIGINT REFERENCES mdm.item(item_id),
  unit_price    NUMERIC(20,4) NOT NULL DEFAULT 0,
  reorder_level NUMERIC(20,4) NOT NULL DEFAULT 0,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    BIGINT REFERENCES sec.app_user(user_id),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by    BIGINT REFERENCES sec.app_user(user_id),
  row_version   INTEGER NOT NULL DEFAULT 1,
  is_deleted    BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT uq_spare_part_code UNIQUE (company_id, part_code)
);

CREATE TABLE IF NOT EXISTS svc.spare_stock (
  stock_id     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  spare_id     BIGINT NOT NULL REFERENCES svc.spare_part(spare_id) ON DELETE CASCADE,
  location     VARCHAR(40) NOT NULL DEFAULT 'MAIN',
  qty_on_hand  NUMERIC(20,4) NOT NULL DEFAULT 0,
  CONSTRAINT uq_spare_stock_location UNIQUE (spare_id, location)
);

-- ---------------------------------------------------------------------
-- 3. Indexes for the List screen filters (active + company scope) and the
--    unique part_code lookup is already covered by uq_spare_part_code.
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ix_spare_part_company_active
  ON svc.spare_part(company_id, is_active);
CREATE INDEX IF NOT EXISTS ix_spare_stock_spare
  ON svc.spare_stock(spare_id);

-- ---------------------------------------------------------------------
-- 4. ROW-LEVEL SECURITY (per-company) on the catalog header. ENABLE (not FORCE):
--    the table owner / superuser BYPASSES RLS, so migrations + the test harness
--    are not filtered; enforcement applies ONLY to the non-superuser erp_app login
--    role. The stock children are always reached via the parent spare (no direct
--    query path), so they carry no company_id and need no policy.
-- ---------------------------------------------------------------------
ALTER TABLE svc.spare_part ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE svc.spare_part IS
  'RLS ENABLED (not FORCE): rls_spare_part_company scopes rows to app.company_id for the erp_app role only; the owner/superuser bypasses (used by tests + migrations). After-sales spare-part catalog; svc.spare_stock holds its per-location on-hand balance; svc.spare_issue (db/04) records per-ticket consumption.';

DROP POLICY IF EXISTS rls_spare_part_company ON svc.spare_part;
CREATE POLICY rls_spare_part_company ON svc.spare_part
  FOR ALL TO erp_app
  USING      (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint);

-- ---------------------------------------------------------------------
-- 5. AUDIT TRIGGER. The catalog table is new (db/06 attaches trg_audit_* only to
--    the pre-existing high-value documents), so add the canonical audit.fn_audit on
--    the header (keyed on the pk spare_id) so every CREATE/EDIT/DELETE is
--    attributed. Guarded on pg_trigger so re-runs are no-ops. The stock child is a
--    derived balance (adjusted via the catalog), so it carries no separate trigger.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_audit_spare_part'
      AND tgrelid = 'svc.spare_part'::regclass
  ) THEN
    CREATE TRIGGER trg_audit_spare_part
      AFTER INSERT OR UPDATE OR DELETE ON svc.spare_part
      FOR EACH ROW EXECUTE FUNCTION audit.fn_audit('spare_id');
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 6. Grants. erp_app needs SELECT/INSERT/UPDATE on both tables (the catalog is
--    soft-delete only — no DELETE on it). The app may remove a stock row when a
--    spare is purged (cascade) or a location is retired, so additionally grant
--    DELETE on the stock child table (least privilege keeps the catalog DELETE-free).
-- ---------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON
    svc.spare_part,
    svc.spare_stock
TO erp_app;
GRANT DELETE ON svc.spare_stock TO erp_app;

-- End migration 032_spares.
