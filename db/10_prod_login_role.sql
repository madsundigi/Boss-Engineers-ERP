-- =====================================================================
-- Boss Engineers ERP — production login role (RLS enforcement)
-- ---------------------------------------------------------------------
-- The application MUST connect as a NON-superuser login role that is a MEMBER of
-- the `erp_app` group role created in db/08_rbac.sql. Every request transaction
-- does `SET LOCAL ROLE erp_app` (see app/src/db/pool.ts); for that to switch
-- successfully the connecting login user must inherit erp_app, and because it is
-- NOT a superuser the Row-Level Security policies actually apply (a superuser or
-- the table owner BYPASSES RLS — fine for migrations/tests, unsafe for the app).
--
-- Run ONCE as a superuser/owner AFTER the schema is built (db/00_run_all.sql),
-- passing the password as a psql variable (never hard-code it):
--   psql "$ADMIN_DATABASE_URL" -v erp_app_pw="$ERP_APP_PW" -f db/10_prod_login_role.sql
-- Then point the app's DATABASE_URL at:
--   postgres://erp_app_login:$ERP_APP_PW@<host>:5432/<db>
-- Idempotent: safe to re-run (re-asserts the password + membership).
-- =====================================================================
\set ON_ERROR_STOP on

SELECT NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app_login') AS need_create \gset
\if :need_create
  CREATE ROLE erp_app_login LOGIN PASSWORD :'erp_app_pw';
\endif

-- (Re)assert the password and group membership; INHERIT so erp_app's table
-- privileges are available without an explicit SET ROLE (the app sets it anyway).
ALTER ROLE erp_app_login WITH LOGIN INHERIT PASSWORD :'erp_app_pw';
GRANT erp_app TO erp_app_login;

-- erp_app_login is intentionally NOT a superuser and NOT BYPASSRLS.
\echo 'erp_app_login is ready — point DATABASE_URL at this role so RLS is enforced.'
