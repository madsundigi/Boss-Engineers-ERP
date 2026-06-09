-- =====================================================================
-- Module M14 — Failure Analysis : NCR cost-impact field
-- Extends qms.ncr (db/04_qms_log_svc.sql + migration 016) with the quantified
-- cost impact of the nonconformance, so the Pareto / repeat-failure report can
-- rank failure modes by COST as well as frequency (spec: cost-impact analysis).
-- Nullable: backward compatible — old code keeps running until redeploy.
-- Idempotent. Apply AFTER migration 016_failure_analysis.
-- =====================================================================

ALTER TABLE qms.ncr
  ADD COLUMN IF NOT EXISTS cost_impact NUMERIC(18,2);

-- End migration 051_ncr_cost.
