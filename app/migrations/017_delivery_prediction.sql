-- =====================================================================
-- Module M09 — Delivery Prediction : incremental migration
-- Extends base proj.delivery_forecast (db/02) — an APPEND-ONLY forecast snapshot
-- log (no status, no row_version, no soft-delete) — with the tenant column and
-- per-company Row-Level Security needed so the non-superuser erp_app role only
-- sees its own company's forecasts. There is NO numbering scope (forecasts are
-- not numbered documents) and NO bu_id. delay_days is a GENERATED column
-- (predicted_delivery - committed_delivery STORED) and is never inserted/updated.
-- Idempotent. Apply AFTER the base schema (db/00_run_all.sql).
-- =====================================================================

-- 1. Tenant column for RLS scoping. proj.delivery_forecast (db/02) has no
--    company_id; add it (nullable so the ADD is non-blocking) then backfill from
--    the owning project.
ALTER TABLE proj.delivery_forecast
  ADD COLUMN IF NOT EXISTS company_id BIGINT REFERENCES mdm.company(company_id);

UPDATE proj.delivery_forecast f
   SET company_id = p.company_id
  FROM proj.project p
 WHERE f.project_id = p.project_id
   AND f.company_id IS NULL;

-- 2. Helpful index for the List / latest-forecast lookups (newest first).
CREATE INDEX IF NOT EXISTS ix_delivery_forecast_project_date
  ON proj.delivery_forecast(project_id, forecast_date DESC);

-- ---------------------------------------------------------------------
-- 3. ROW-LEVEL SECURITY (per-company), mirroring the dispatch surface (013).
--    ENABLE (not FORCE) is deliberate: the table owner / superuser BYPASSES RLS,
--    so migrations + the test harness (which connect as the owner) are not
--    filtered. Enforcement applies ONLY to the non-superuser erp_app login role.
--    The repository INSERT sets company_id = ctx.companyId so new rows pass the
--    policy's WITH CHECK.
-- ---------------------------------------------------------------------
ALTER TABLE proj.delivery_forecast ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE proj.delivery_forecast IS
  'RLS ENABLED (not FORCE): rls_delivery_forecast_company scopes rows to app.company_id for the erp_app role only; the owner/superuser bypasses (used by tests + migrations). Append-only forecast snapshot log: each prediction is a new immutable row (no status/row_version/soft-delete); delay_days is GENERATED (predicted_delivery - committed_delivery).';

DROP POLICY IF EXISTS rls_delivery_forecast_company ON proj.delivery_forecast;
CREATE POLICY rls_delivery_forecast_company ON proj.delivery_forecast
  FOR ALL TO erp_app
  USING      (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint);

-- ---------------------------------------------------------------------
-- 4. GRANTS. erp_app already has SELECT/INSERT on proj.* from db/08; re-assert
--    defensively. Append-only — no UPDATE/DELETE grant is needed or wanted.
-- ---------------------------------------------------------------------
GRANT SELECT, INSERT ON proj.delivery_forecast TO erp_app;

-- End migration 017_delivery_prediction.
