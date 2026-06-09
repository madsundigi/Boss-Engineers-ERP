-- =====================================================================
-- Module M07 — Employee Workload : allocation completion %
-- Extends hcm.resource_allocation (db/03 + migration 008) with an OPTIONAL
-- completion percentage (0..100) so a planner can track how far along an
-- allocation is, in addition to its planned hours. The department of the
-- assigned employee is surfaced on the read projection (JOIN to
-- hcm.department) — no schema change needed for that.
-- Nullable: backward compatible — old code keeps running until redeploy.
-- A CHECK bounds the value to 0..100 (NULL always permitted).
-- Idempotent. Apply AFTER migration 008_workload.
-- =====================================================================

ALTER TABLE hcm.resource_allocation
  ADD COLUMN IF NOT EXISTS completion_pct NUMERIC(5,2);

ALTER TABLE hcm.resource_allocation DROP CONSTRAINT IF EXISTS ck_alloc_completion;
ALTER TABLE hcm.resource_allocation ADD CONSTRAINT ck_alloc_completion
  CHECK (completion_pct IS NULL OR completion_pct BETWEEN 0 AND 100);

-- End migration 046_alloc_completion.
