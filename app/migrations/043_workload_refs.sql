-- =====================================================================
-- Module M07 — Employee Workload : downstream work-item reference
-- Extends hcm.resource_allocation (db/03 + migration 008) with an OPTIONAL,
-- lightweight generic reference so an allocation can point at the specific
-- downstream work item it serves (Production work-order / FAT / Installation),
-- IN ADDITION to its existing project_id + task_id links. This closes the
-- flowchart's "Workload connected to Production, FAT, Installation" arrow.
--
-- Two nullable columns rather than three separate FKs (the targets live in
-- different schemas/tables, so a polymorphic ref_type/ref_id pair keeps the
-- coupling loose and avoids cross-module FK churn):
--   ref_type  — discriminator: 'WORK_ORDER' | 'FAT' | 'INSTALLATION' (nullable)
--   ref_id    — the target row id in that work item's table (nullable)
-- Both nullable: backward compatible — old code keeps running until redeploy.
-- A CHECK constrains ref_type to the allowed set (NULL always permitted).
-- Idempotent. Apply AFTER migration 008_workload.
-- =====================================================================

ALTER TABLE hcm.resource_allocation
  ADD COLUMN IF NOT EXISTS ref_type VARCHAR(20),
  ADD COLUMN IF NOT EXISTS ref_id   BIGINT;

ALTER TABLE hcm.resource_allocation DROP CONSTRAINT IF EXISTS ck_alloc_ref_type;
ALTER TABLE hcm.resource_allocation ADD CONSTRAINT ck_alloc_ref_type
  CHECK (ref_type IS NULL OR ref_type IN ('WORK_ORDER', 'FAT', 'INSTALLATION'));

-- End migration 043_workload_refs.
