-- =====================================================================
-- Module M08 — Production / Work Order : execution progress fields
-- Extends mfg.work_order (db/04 + migration 012) with 2 more optional
-- in-flight execution fields from the product spec: a free-text delay
-- reason and a percent-complete metric for shop-floor progress tracking.
-- All nullable: backward compatible — old code keeps running until redeploy.
-- Idempotent. Apply AFTER migration 012_production.
-- =====================================================================

ALTER TABLE mfg.work_order
  ADD COLUMN IF NOT EXISTS delay_reason     VARCHAR(200),
  ADD COLUMN IF NOT EXISTS percent_complete NUMERIC(5,2);

ALTER TABLE mfg.work_order DROP CONSTRAINT IF EXISTS ck_wo_percent;
ALTER TABLE mfg.work_order ADD CONSTRAINT ck_wo_percent
  CHECK (percent_complete IS NULL OR percent_complete BETWEEN 0 AND 100);

-- End migration 047_wo_progress.
