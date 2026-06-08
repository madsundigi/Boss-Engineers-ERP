#!/usr/bin/env bash
# One-command PRODUCTION database bootstrap. Run ONCE against a clean database
# using an OWNER/superuser connection string. Safe to re-run (idempotent).
#
#   ADMIN_DATABASE_URL='postgres://owner:pw@host:5432/db' \
#   ERP_APP_PW='strong-role-password' \
#   ADMIN_PW='Strong#Admin1!' \
#   ./app/scripts/bootstrap-prod.sh
#
# Afterwards run the API with the NON-superuser login role so RLS is enforced:
#   DATABASE_URL=postgres://erp_app_login:<ERP_APP_PW>@host:5432/db
set -euo pipefail
: "${ADMIN_DATABASE_URL:?set ADMIN_DATABASE_URL (owner/superuser connection string)}"
: "${ERP_APP_PW:?set ERP_APP_PW (password for the erp_app_login role)}"
: "${ADMIN_PW:?set ADMIN_PW (initial password for the admin login)}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

echo "1/4  Building schema (db/00_run_all.sql)…"
psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$ROOT/db/00_run_all.sql"

echo "2/4  Applying app migrations…"
( cd "$ROOT/app" && DATABASE_URL="$ADMIN_DATABASE_URL" npm run --silent migrate )

echo "3/4  Provisioning the RLS login role (erp_app_login)…"
psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -v erp_app_pw="$ERP_APP_PW" -f "$ROOT/db/10_prod_login_role.sql"

echo "4/4  Setting the admin password…"
( cd "$ROOT/app" && DATABASE_URL="$ADMIN_DATABASE_URL" npm run --silent set-password admin "$ADMIN_PW" )

echo "5/5  Granting the admin user the ADMIN role with full permissions…"
psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -q <<'SQL'
-- The base seed creates the 'admin' login but does not assign it a role. Link it
-- to ADMIN and make ADMIN a full superuser so the first admin can set everything
-- up (create users, assign roles). Idempotent.
INSERT INTO sec.user_role (user_id, role_id)
SELECT u.user_id, r.role_id FROM sec.app_user u CROSS JOIN sec.role r
WHERE u.username = 'admin' AND r.role_code = 'ADMIN'
ON CONFLICT DO NOTHING;
INSERT INTO sec.role_permission (role_id, permission_id)
SELECT r.role_id, p.permission_id FROM sec.role r CROSS JOIN sec.permission p
WHERE r.role_code = 'ADMIN'
ON CONFLICT DO NOTHING;
SQL

cat <<DONE

Bootstrap complete. Configure the API service with:
  DATABASE_URL=postgres://erp_app_login:<ERP_APP_PW>@<host>:5432/<db>
  AUTH_JWT_SECRET=<long random>   # node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
  CORS_ORIGINS=<your app origin(s)>
Then sign in as 'admin' (company id 1) with the password you set, and create your real users/roles.
DONE
