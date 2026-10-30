#!/bin/sh
# Nightly database dump kept on the VPS (14 most recent), for hosts without off-site backup yet.
# Cron: 40 2 * * * /opt/sd-leads/deploy/backup-local.sh >> /var/log/sd-leads-backup.log 2>&1
set -eu
cd "$(dirname "$0")/.."
DIR=/root/backups/sd-leads
mkdir -p "$DIR"
FILE="$DIR/sd-leads-$(date +%Y%m%d-%H%M).dump"
docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB"' > "$FILE.tmp"
mv "$FILE.tmp" "$FILE"
ls -1t "$DIR"/*.dump | tail -n +15 | xargs -r rm -f
echo "$(date -Is) backup ok: $FILE ($(du -h "$FILE" | cut -f1))"
