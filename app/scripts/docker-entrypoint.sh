#!/bin/sh
# =====================================================================
# Container entrypoint: apply DB migrations (as the owner) THEN start the API.
#
# The runtime DATABASE_URL is the restricted erp_app_login role, which has NO
# DDL rights — so migrations run only when MIGRATE_DATABASE_URL is set to an
# OWNER connection string (Render's Internal Database URL with the owner user).
#   * MIGRATE_DATABASE_URL set   -> auto-migrate on every deploy/boot (idempotent).
#   * MIGRATE_DATABASE_URL unset -> skip (apply migrations manually as owner).
#
# A migration failure is logged loudly but does NOT block the API from starting,
# so an existing deployment stays up; new-schema features may 500 until fixed.
# =====================================================================
set -u

if [ -n "${MIGRATE_DATABASE_URL:-}" ]; then
  echo "[entrypoint] MIGRATE_DATABASE_URL set — applying DB migrations (owner)…"
  if node dist/scripts/migrate.js; then
    echo "[entrypoint] migrations up to date."
  else
    echo "[entrypoint] WARNING: migrations FAILED — starting API anyway; new-schema features may 500 until resolved." >&2
  fi
else
  echo "[entrypoint] MIGRATE_DATABASE_URL not set — skipping auto-migrate (apply migrations manually as the DB owner)."
fi

exec node dist/src/server.js
