-- =====================================================================
-- Migration 053 — DELETE grant for the hard-deletable master tables
-- ---------------------------------------------------------------------
-- The application role (erp_app) is SELECT/INSERT/UPDATE-only by design — the
-- whole system soft-deletes (is_deleted) for auditability, so erp_app has no
-- DELETE. But three master tables have NO is_deleted column and are managed by
-- hard-delete / checklist-line replacement:
--   mdm.warehouse, mdm.work_center, qms.fat_protocol (+ its qms.fat_protocol_param
--   lines, which the protocol editor replaces).
-- Grant DELETE on just those four so their new master-data CRUD modules work. An
-- in-use row stays protected by its child foreign keys (23503 -> 409). Idempotent.
-- =====================================================================

GRANT DELETE ON
    mdm.warehouse,
    mdm.work_center,
    qms.fat_protocol,
    qms.fat_protocol_param
  TO erp_app;

-- End migration 053_master_delete_grants.
