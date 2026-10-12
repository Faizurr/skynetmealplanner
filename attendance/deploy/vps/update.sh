#!/usr/bin/env bash
# Rebuilds and restarts from the current checkout. Run from the attendance/ folder after `git pull`:
#   sudo attendance-update
# The previous build is kept as *.old for a quick rollback:
#   sudo attendance-update --rollback
# Note: rollback restores code only; if the update ran a migration, restore the pre-update backup too.
set -euo pipefail
APP_DIR=/opt/attendance

if [ "${1:-}" = "--rollback" ]; then
  for part in server web; do
    if [ -d "$APP_DIR/$part.old" ]; then
      rm -rf "${APP_DIR:?}/${part:?}.bad"
      mv "$APP_DIR/$part" "$APP_DIR/$part.bad"
      mv "$APP_DIR/$part.old" "$APP_DIR/$part"
    fi
  done
  systemctl restart attendance
  echo "Rolled back to the previous build."
  exit 0
fi

SRC="$(pwd)"
[ -f "$SRC/deploy/vps/install.sh" ] || { echo "Run from the attendance/ folder of the repository"; exit 1; }
/usr/local/bin/attendance-backup   # always back up before upgrading (migrations may run)
exec bash "$SRC/deploy/vps/install.sh"
