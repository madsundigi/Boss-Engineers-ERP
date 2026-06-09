-- =====================================================================
-- MDM — Item : minimum / safety stock level
-- Extends mdm.item (db/02) with a minimum-stock (safety) level to sit
-- alongside the existing reorder_level. Surfaced read-only on the
-- Inventory stock screen so planners see both Minimum Level and Reorder
-- Level per item; no create DTO (item is master data, maintained in MDM).
-- Nullable: backward compatible — old code keeps running until redeploy.
-- Idempotent. Apply AFTER db/02 (and any earlier mdm.item migrations).
-- =====================================================================

ALTER TABLE mdm.item ADD COLUMN IF NOT EXISTS min_level NUMERIC(20,4);

-- End migration 045_item_min_level.
