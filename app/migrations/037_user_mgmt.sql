-- =====================================================================
-- User & Role Administration — privilege top-up for the application role.
-- ---------------------------------------------------------------------
-- The sec.* security tables (app_user, role, user_role, role_permission,
-- permission) are GLOBAL — no company_id, no RLS — and erp_app already holds
-- SELECT/INSERT/UPDATE on ALL of them (db/06_constraints_automation.sql, the
-- "GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA sec ... TO erp_app").
--
-- The one missing privilege is DELETE on sec.user_role. The "replace a user's
-- roles" endpoint (PUT /api/users/:id/roles) deletes the user's existing
-- user_role rows and inserts the new least-privilege set in one transaction;
-- without DELETE the app could only ever ADD roles, never revoke them — which
-- defeats the point of moving everyone off superuser. Grant exactly that, and
-- nothing more (no new tables, no RLS — these are global security tables).
--
-- Idempotent: GRANT is naturally repeatable.
-- =====================================================================

GRANT DELETE ON sec.user_role TO erp_app;

-- End migration 037_user_mgmt.
