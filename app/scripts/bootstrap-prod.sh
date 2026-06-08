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

cat <<DONE

Bootstrap complete. Configure the API service with:
  DATABASE_URL=postgres://erp_app_login:<ERP_APP_PW>@<host>:5432/<db>
  AUTH_JWT_SECRET=<long random>   # node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
  CORS_ORIGINS=<your app origin(s)>
Then sign in as 'admin' (company id 1) with the password you set, and create your real users/roles.
DONE
