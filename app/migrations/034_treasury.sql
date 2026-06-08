-- =====================================================================
-- Tier-3 — Treasury / Cash-flow : new module
-- Creates fin.cashflow_forecast (project-linked cash-flow forecast entries — an
-- expected INFLOW/OUTFLOW in a period, by category, optionally tied to a project),
-- seeds the new 'TREASURY' RBAC domain (absent from db/08), and wires per-company
-- RLS, the composite (company_id, bu_id) FK and erp_app grants. The forecast log is
-- APPEND-ONLY (each entry is a new immutable row; a correction is a newer offsetting
-- row) — so there is NO row_version/soft-delete and NO audit trigger (cf. the
-- delivery forecast, migration 017). The working-capital POSITION read in the
-- service is a pure SELECT over fin.invoice / fin.vendor_invoice /
-- fin.payment_allocation (db/05) and needs no new schema.
-- Idempotent. Apply AFTER db/00_run_all.sql and the earlier migrations.
-- =====================================================================

-- 1. RBAC: seed the TREASURY permission domain + role grants (flag-letter idiom, db/08).
INSERT INTO sec.permission (perm_code, module, action, description)
SELECT 'TREASURY.' || a, 'TREASURY', a, a || ' on TREASURY'
FROM (VALUES ('VIEW'),('CREATE'),('EDIT'),('DELETE'),('APPROVE'),('EXPORT')) v(a)
ON CONFLICT (perm_code) DO NOTHING;

INSERT INTO sec.role_permission (role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM (VALUES
    ('FINANCE','VCEDA'),('CEO','VAX'),('ADMIN','VCEDAX'),('PLANNING','V')
  ) g(role_code, flags)
JOIN sec.role r ON r.role_code = g.role_code
JOIN LATERAL (VALUES ('V','VIEW'),('C','CREATE'),('E','EDIT'),('D','DELETE'),('A','APPROVE'),('X','EXPORT')) f(letter, action)
  ON position(f.letter in g.flags) > 0
JOIN sec.permission p ON p.module = 'TREASURY' AND p.action = f.action
ON CONFLICT DO NOTHING;

-- 2. Table (append-only: no row_version / is_deleted / updated_* columns).
CREATE TABLE IF NOT EXISTS fin.cashflow_forecast (
  cf_id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id    BIGINT NOT NULL REFERENCES mdm.company(company_id),
  bu_id         BIGINT REFERENCES mdm.business_unit(bu_id),
  forecast_date DATE NOT NULL DEFAULT current_date,
  period_label  VARCHAR(10),
  direction     VARCHAR(10) NOT NULL CHECK (direction IN ('INFLOW','OUTFLOW')),
  category      VARCHAR(20) CHECK (category IN ('MILESTONE','ADVANCE','VENDOR','PAYROLL','TAX','OVERHEAD','OTHER')),
  amount        NUMERIC(20,4) NOT NULL,
  project_id    BIGINT REFERENCES proj.project(project_id),
  note          VARCHAR(300),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    BIGINT REFERENCES sec.app_user(user_id)
);

CREATE INDEX IF NOT EXISTS ix_cashflow_forecast_scope ON fin.cashflow_forecast(company_id, period_label);

-- 3. Row-Level Security (per-company), mirroring the other business tables.
--    ENABLE (not FORCE): the table owner / superuser BYPASSES RLS, so migrations +
--    the test harness (which connect as the owner) are not filtered; enforcement
--    applies only to the non-superuser erp_app login role. The repository INSERT sets
--    company_id = ctx.companyId so new rows pass the policy's WITH CHECK.
ALTER TABLE fin.cashflow_forecast ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE fin.cashflow_forecast IS
  'RLS ENABLED (not FORCE): rls_cashflow_company scopes rows to app.company_id for the erp_app role only; the owner/superuser bypasses (tests + migrations). Append-only cash-flow forecast log: each entry is a new immutable row (no row_version/soft-delete); a correction is a newer offsetting row.';
DROP POLICY IF EXISTS rls_cashflow_company ON fin.cashflow_forecast;
CREATE POLICY rls_cashflow_company ON fin.cashflow_forecast
  FOR ALL TO erp_app
  USING      (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint);

-- 4. Branch/company integrity: a forecast's branch must belong to its company.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_cashflow_bu_company' AND conrelid = 'fin.cashflow_forecast'::regclass
  ) THEN
    ALTER TABLE fin.cashflow_forecast
      ADD CONSTRAINT fk_cashflow_bu_company
      FOREIGN KEY (company_id, bu_id) REFERENCES mdm.business_unit (company_id, bu_id);
  END IF;
END $$;

-- 5. Grants for the RLS-enforced app role. Append-only — no UPDATE/DELETE grant.
GRANT SELECT, INSERT ON fin.cashflow_forecast TO erp_app;

-- End migration 034_treasury.
