-- =====================================================================
-- Module M10 — Factory Acceptance Test : responsible engineer
-- Extends qms.fat_execution (db/04 + migration 009) with the FAT engineer
-- (the QC/test engineer who executes the protocol) from the product spec.
-- Nullable FK to sec.app_user: backward compatible — old code keeps running
-- until redeploy.
-- Idempotent. Apply AFTER migration 009_fat.
-- =====================================================================

ALTER TABLE qms.fat_execution
  ADD COLUMN IF NOT EXISTS engineer_id BIGINT REFERENCES sec.app_user(user_id);

-- End migration 048_fat_engineer.
