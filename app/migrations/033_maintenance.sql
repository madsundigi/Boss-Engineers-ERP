-- =====================================================================
-- Tier-3 — Plant Maintenance : new module
-- The own-asset / tooling register + its preventive / breakdown / calibration
-- maintenance work orders. The base model has NO plant-maintenance schema at all,
-- so this migration CREATES a new 'maint' schema with two tables:
--   maint.asset       — one row per maintainable asset (machine / tool / vehicle /
--                       instrument), unique asset_code per company, with a status
--   maint.work_order  — a branch-numbered maintenance work order (MWO) raised
--                       against an asset, with a PREVENTIVE/BREAKDOWN/CALIBRATION
--                       type and an OPEN -> IN_PROGRESS -> DONE (+ CANCELLED) lifecycle
--
-- It seeds the 'MAINTENANCE' RBAC domain (absent from the db/08 catalog), registers
-- a branch-scoped 'MWO' document-numbering rule (prefix 'MWO', not in the db/07 seed),
-- enables per-company Row-Level Security on both tables, wires the composite
-- (company_id, bu_id) FK on the work order, the audit triggers (db/06 has none for
-- these new tables), and grants erp_app the DML it needs.
--
-- Idempotent. Apply AFTER the base schema (db/00_run_all.sql) and the earlier
-- migrations. RLS is ENABLE (not FORCE): the owner/superuser used by migrations +
-- the integration test harness bypasses it; only the erp_app login role is scoped.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. SCHEMA. Plant Maintenance gets its own namespace (not in db/01). erp_app must
--    be able to reach it, so grant USAGE (table-level DML is granted in step 8).
-- ---------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS maint;
GRANT USAGE ON SCHEMA maint TO erp_app;

-- ---------------------------------------------------------------------
-- 1. RBAC — seed the 'MAINTENANCE' permission domain (db/08 has no such module) and
--    grant it to roles (flag-letter idiom, db/08 / 031 / 032). PRODUCTION runs the
--    register + work orders (VCEDA), STORES maintains assets (VCE), ADMIN holds all
--    six (VCEDAX), CEO views + exports (VX), FINANCE reads (V), QC views + creates
--    (calibration WOs) (VC). perm_code is 'MAINTENANCE.<ACTION>'.
-- ---------------------------------------------------------------------
INSERT INTO sec.permission (perm_code, module, action, description)
SELECT 'MAINTENANCE.' || a, 'MAINTENANCE', a, a || ' on MAINTENANCE'
FROM (VALUES ('VIEW'),('CREATE'),('EDIT'),('DELETE'),('APPROVE'),('EXPORT')) v(a)
ON CONFLICT (perm_code) DO NOTHING;

INSERT INTO sec.role_permission (role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM (VALUES
    ('PRODUCTION','VCEDA'),('STORES','VCE'),('ADMIN','VCEDAX'),
    ('CEO','VX'),('FINANCE','V'),('QC','VC')
  ) g(role_code, flags)
JOIN sec.role r ON r.role_code = g.role_code
JOIN LATERAL (VALUES ('V','VIEW'),('C','CREATE'),('E','EDIT'),('D','DELETE'),('A','APPROVE'),('X','EXPORT')) f(letter, action)
  ON position(f.letter in g.flags) > 0
JOIN sec.permission p ON p.module = 'MAINTENANCE' AND p.action = f.action
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------
-- 2. TABLES. The asset register header + its maintenance work orders. bigint-
--    identity PKs + the canonical audit/concurrency columns (mirrors db/05 / 031).
--    asset_code is the user-supplied code, unique (company_id, asset_code) within a
--    tenant. The work order carries bu_id (branch) so its MWO number is branch-scoped.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS maint.asset (
  asset_id     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id   BIGINT NOT NULL REFERENCES mdm.company(company_id),
  asset_code   VARCHAR(30) NOT NULL,
  asset_name   VARCHAR(200) NOT NULL,
  asset_type   VARCHAR(20) CHECK (asset_type IN ('MACHINE','TOOL','VEHICLE','INSTRUMENT','OTHER')),
  location     VARCHAR(60),
  status       VARCHAR(20) NOT NULL DEFAULT 'ACTIVE'
                 CHECK (status IN ('ACTIVE','UNDER_MAINTENANCE','RETIRED')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by   BIGINT REFERENCES sec.app_user(user_id),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by   BIGINT REFERENCES sec.app_user(user_id),
  row_version  INTEGER NOT NULL DEFAULT 1,
  is_deleted   BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT uq_maint_asset_code UNIQUE (company_id, asset_code)
);

CREATE TABLE IF NOT EXISTS maint.work_order (
  mwo_id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id      BIGINT NOT NULL REFERENCES mdm.company(company_id),
  bu_id           BIGINT REFERENCES mdm.business_unit(bu_id),
  mwo_no          VARCHAR(30) NOT NULL,
  asset_id        BIGINT NOT NULL REFERENCES maint.asset(asset_id),
  wo_type         VARCHAR(15) NOT NULL
                    CHECK (wo_type IN ('PREVENTIVE','BREAKDOWN','CALIBRATION')),
  scheduled_date  DATE,
  completed_date  DATE,
  status          VARCHAR(15) NOT NULL DEFAULT 'OPEN'
                    CHECK (status IN ('OPEN','IN_PROGRESS','DONE','CANCELLED')),
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by      BIGINT REFERENCES sec.app_user(user_id),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by      BIGINT REFERENCES sec.app_user(user_id),
  row_version     INTEGER NOT NULL DEFAULT 1,
  is_deleted      BOOLEAN NOT NULL DEFAULT false
);

-- ---------------------------------------------------------------------
-- 3. Indexes for the List screen filters (company + status scope on both tables).
--    uq_maint_asset_code already covers the asset_code lookup.
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ix_maint_asset_company_status ON maint.asset(company_id, status);
CREATE INDEX IF NOT EXISTS ix_maint_wo_company_status    ON maint.work_order(company_id, status);
CREATE INDEX IF NOT EXISTS ix_maint_wo_asset             ON maint.work_order(asset_id);

-- ---------------------------------------------------------------------
-- 4. ROW-LEVEL SECURITY (per-company) on both tables. ENABLE (not FORCE): the table
--    owner / superuser BYPASSES RLS, so migrations + the test harness are not
--    filtered; enforcement applies ONLY to the non-superuser erp_app login role.
--    Scope is taken from the transaction-local GUC app.company_id.
-- ---------------------------------------------------------------------
ALTER TABLE maint.asset ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE maint.asset IS
  'RLS ENABLED (not FORCE): rls_maint_asset_company scopes rows to app.company_id for the erp_app role only; the owner/superuser bypasses (used by tests + migrations). Plant-maintenance asset / tooling register; maint.work_order holds its maintenance work orders.';
DROP POLICY IF EXISTS rls_maint_asset_company ON maint.asset;
CREATE POLICY rls_maint_asset_company ON maint.asset
  FOR ALL TO erp_app
  USING      (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint);

ALTER TABLE maint.work_order ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE maint.work_order IS
  'RLS ENABLED (not FORCE): rls_maint_wo_company scopes rows to app.company_id for the erp_app role only; the owner/superuser bypasses (used by tests + migrations). Branch-numbered maintenance work order (MWO) against a maint.asset.';
DROP POLICY IF EXISTS rls_maint_wo_company ON maint.work_order;
CREATE POLICY rls_maint_wo_company ON maint.work_order
  FOR ALL TO erp_app
  USING      (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint);

-- ---------------------------------------------------------------------
-- 5. BUSINESS-UNIT / COMPANY INTEGRITY: a work order's branch must belong to its
--    company. bu_id is nullable; MATCH SIMPLE skips the check when NULL. uq_bu_company
--    exists from 003_security_hardening.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_maint_wo_bu_company'
      AND conrelid = 'maint.work_order'::regclass
  ) THEN
    ALTER TABLE maint.work_order
      ADD CONSTRAINT fk_maint_wo_bu_company
      FOREIGN KEY (company_id, bu_id)
      REFERENCES mdm.business_unit (company_id, bu_id);
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 6. NUMBERING RULE for 'MWO' — branch-scoped, prefix 'MWO', FY reset. Not present
--    in the db/07 seed, so add one rule per BE branch. Mirrors the db/07 / 012
--    pattern; guarded so re-runs are no-ops. mdm.next_document_no(company,bu,'MWO')
--    allocates the document number atomically in the create transaction.
-- ---------------------------------------------------------------------
INSERT INTO mdm.numbering_rule (company_id, bu_id, doc_type, prefix, format_template, pad_width, reset_policy)
SELECT c.company_id, bu.bu_id, 'MWO', 'MWO', '{PREFIX}/{BRANCH}/{FY}/{SEQ}', 6, 'FY'
FROM mdm.company c
JOIN mdm.business_unit bu ON bu.company_id = c.company_id
WHERE c.company_code = 'BE'
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------
-- 7. AUDIT TRIGGERS. Both tables are new (db/06 attaches trg_audit_* only to the
--    pre-existing high-value documents), so add the canonical audit.fn_audit on each
--    (keyed on its pk) so every CREATE/EDIT/DELETE is attributed. Guarded on
--    pg_trigger so re-runs are no-ops.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_audit_maint_asset'
      AND tgrelid = 'maint.asset'::regclass
  ) THEN
    CREATE TRIGGER trg_audit_maint_asset
      AFTER INSERT OR UPDATE OR DELETE ON maint.asset
      FOR EACH ROW EXECUTE FUNCTION audit.fn_audit('asset_id');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_audit_maint_wo'
      AND tgrelid = 'maint.work_order'::regclass
  ) THEN
    CREATE TRIGGER trg_audit_maint_wo
      AFTER INSERT OR UPDATE OR DELETE ON maint.work_order
      FOR EACH ROW EXECUTE FUNCTION audit.fn_audit('mwo_id');
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 8. Grants. erp_app needs SELECT/INSERT/UPDATE on both tables (both are soft-delete
--    only — no DELETE grant; the parent rows are retired via is_deleted).
-- ---------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON
    maint.asset,
    maint.work_order
TO erp_app;

-- End migration 033_maintenance.
