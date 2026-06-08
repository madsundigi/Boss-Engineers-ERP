#!/usr/bin/env bash
# Boss Engineers ERP — database backup (point-in-time dump).
#   DATABASE_URL=postgres://... ./scripts/backup.sh [outdir]
# Restore:
#   pg_restore --clean --if-exists --no-owner -d "$TARGET_URL" <dumpfile>
# Schedule via cron/systemd-timer; keep dumps off-box (S3/GCS) for real DR.
set -euo pipefail
: "${DATABASE_URL:?set DATABASE_URL to the database to back up}"

OUT="${1:-backups}"
mkdir -p "$OUT"
STAMP="$(date +%Y%m%d-%H%M%S)"
FILE="$OUT/be-erp-$STAMP.dump"

# Custom format = compressed + selective pg_restore.
pg_dump --format=custom --no-owner --no-privileges "$DATABASE_URL" -f "$FILE"
echo "wrote $FILE ($(du -h "$FILE" | cut -f1))"

# Retain the most recent 14 local dumps.
ls -1t "$OUT"/be-erp-*.dump 2>/dev/null | tail -n +15 | xargs -r rm -f
