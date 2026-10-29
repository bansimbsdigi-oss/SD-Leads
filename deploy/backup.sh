#!/bin/sh
# Nightly encrypted pg_dump, copied off-VPS with rclone (Backblaze B2). Keeps 14 local copies.
set -eu
apk add --no-cache rclone gnupg >/dev/null
while true; do
  now=$(date +%H%M)
  if [ "$now" = "0230" ]; then
    file="/backups/sabhi_leads-$(date +%Y%m%d).sql.gz.gpg"
    pg_dump --format=plain --no-owner | gzip | gpg --batch --symmetric --cipher-algo AES256 --passphrase "$BACKUP_PASSPHRASE" -o "$file"
    rclone copy "$file" "$RCLONE_REMOTE" && echo "backup uploaded: $file"
    ls -1t /backups/*.gpg | tail -n +15 | xargs -r rm -f
    sleep 60
  fi
  sleep 30
done
