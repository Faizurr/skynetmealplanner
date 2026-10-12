#!/usr/bin/env bash
# Nightly PostgreSQL backup (custom format, compressed) + copy of the config. Keeps 14 days locally.
# Restore: see docs/BACKUP_RESTORE.md. Off-site copy (strongly recommended): configure rclone
# (e.g. to Google Drive / Backblaze B2) and uncomment the last line.
set -euo pipefail
DIR=/var/backups/attendance
mkdir -p "$DIR" && chmod 700 "$DIR"
STAMP=$(date +%F-%H%M)
# shellcheck disable=SC2024 # intentional: root (cron) writes the file, pg_dump runs as postgres
sudo -u postgres pg_dump --format=custom --no-owner --no-privileges attendance > "$DIR/attendance-$STAMP.dump"
cp /etc/attendance.env "$DIR/attendance-env-$STAMP.bak"
chmod 600 "$DIR"/*
find "$DIR" -type f -mtime +14 -delete
echo "$(date -Is) backup ok: $DIR/attendance-$STAMP.dump ($(du -h "$DIR/attendance-$STAMP.dump" | cut -f1))"
# rclone copy "$DIR" remote:attendance-backups --max-age 2d
