#!/usr/bin/env bash
# =============================================================================
# Restaurant Attendance — one-command install on a small VPS (1 vCPU, 512 MB–1 GB RAM)
# Supported: Ubuntu 22.04 / 24.04, Debian 12 (x86_64 or arm64). Run as root from a checkout:
#
#   git clone -b <branch> https://github.com/<you>/<repo>.git /root/src
#   cd /root/src/attendance && sudo DOMAIN=attendance.example.com LE_EMAIL=you@example.com bash deploy/vps/install.sh
#
# DOMAIN is optional: without it a free hostname <ip>.sslip.io is used, and Caddy still obtains a real
# Let's Encrypt HTTPS certificate (required for the PWA install and the kiosk).
# Re-running is safe: secrets are generated once and never overwritten.
# =============================================================================
set -euo pipefail

APP_USER=attendance
APP_DIR=/opt/attendance
ENV_FILE=/etc/attendance.env
NODE_VERSION=${NODE_VERSION:-22.22.0}
SRC_DIR="$(cd "$(dirname "$0")/../.." && pwd)"   # the attendance/ folder of the checkout

log() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
die() { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "run as root (sudo)"
[ -f "$SRC_DIR/server/package.json" ] || die "run this from the attendance/ folder of the repository"
# shellcheck disable=SC1091
. /etc/os-release
case "$ID" in ubuntu|debian) ;; *) die "unsupported OS: $ID (use Ubuntu 22.04/24.04 or Debian 12)";; esac

PUBLIC_IP=$(curl -fsS4 https://api.ipify.org || curl -fsS4 https://ifconfig.me || true)
DOMAIN=${DOMAIN:-}
if [ -z "$DOMAIN" ]; then
  [ -n "$PUBLIC_IP" ] || die "could not detect the public IP; pass DOMAIN=..."
  DOMAIN="${PUBLIC_IP//./-}.sslip.io"
fi
LE_EMAIL=${LE_EMAIL:-}

# --------------------------------------------------------------------------- swap
MEM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
if [ "$MEM_MB" -lt 2000 ] && ! swapon --show | grep -q .; then
  log "Adding 1 GB swap (RAM is ${MEM_MB} MB)"
  fallocate -l 1G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=1024
  chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  sysctl -q vm.swappiness=10 && echo 'vm.swappiness=10' > /etc/sysctl.d/99-attendance.conf
fi

# --------------------------------------------------------------------------- packages
log "Installing system packages (PostgreSQL, Caddy, firewall)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg xz-utils ufw cron postgresql postgresql-contrib \
  debian-keyring debian-archive-keyring apt-transport-https >/dev/null
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy >/dev/null
fi

# --------------------------------------------------------------------------- node
if ! /opt/node/bin/node --version 2>/dev/null | grep -q "v$NODE_VERSION"; then
  log "Installing Node.js $NODE_VERSION"
  case "$(uname -m)" in x86_64) ARCH=x64;; aarch64|arm64) ARCH=arm64;; *) die "unsupported CPU $(uname -m)";; esac
  TMP=$(mktemp -d)
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-$ARCH.tar.xz" -o "$TMP/node.tar.xz"
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" -o "$TMP/SHASUMS256.txt"
  EXPECTED=$(grep " node-v$NODE_VERSION-linux-$ARCH.tar.xz\$" "$TMP/SHASUMS256.txt" | cut -d' ' -f1)
  [ -n "$EXPECTED" ] && echo "$EXPECTED  $TMP/node.tar.xz" | sha256sum -c --quiet - || die "Node checksum mismatch"
  rm -rf /opt/node
  mkdir -p /opt/node && tar -xJf "$TMP/node.tar.xz" -C /opt/node --strip-components=1
  rm -rf "${TMP:?}"
fi
export PATH=/opt/node/bin:$PATH

# --------------------------------------------------------------------------- postgres (low-memory tuning)
log "Configuring PostgreSQL for a small server"
PG_CONF_DIR=$(find /etc/postgresql -maxdepth 2 -type d -name main | sort -V | tail -1)
[ -n "$PG_CONF_DIR" ] || die "PostgreSQL configuration directory not found"
mkdir -p "$PG_CONF_DIR/conf.d"
cat > "$PG_CONF_DIR/conf.d/attendance.conf" <<CONF
# Tuned for a 512 MB–1 GB RAM VPS (Restaurant Attendance)
listen_addresses = 'localhost'
max_connections = 30
shared_buffers = 64MB
effective_cache_size = 256MB
work_mem = 4MB
maintenance_work_mem = 32MB
wal_buffers = 4MB
checkpoint_completion_target = 0.9
random_page_cost = 1.1
log_min_duration_statement = 1000
CONF
systemctl enable postgresql >/dev/null 2>&1 || true
systemctl restart postgresql

# --------------------------------------------------------------------------- secrets (generated once)
rand() { head -c 48 /dev/urandom | base64 | tr -d '/+=\n' | head -c 32; }
if [ ! -f "$ENV_FILE" ]; then
  log "Generating secrets in $ENV_FILE"
  OWNER_PW=$(rand); APP_PW=$(rand)
  umask 077
  cat > "$ENV_FILE" <<ENV
# Restaurant Attendance configuration. KEEP A COPY OF THIS FILE SOMEWHERE SAFE (password manager).
# Losing TEMPLATE_KEYS means staff must re-enrol their faces (attendance data is not affected).
NODE_ENV=production
PORT=8080
HOST=127.0.0.1
PUBLIC_BASE_URL=https://$DOMAIN
TRUST_PROXY=true
DATABASE_URL=postgres://att_app:$APP_PW@localhost:5432/attendance
MIGRATION_DATABASE_URL=postgres://att_owner:$OWNER_PW@localhost:5432/attendance
APP_DB_ROLE=att_app
DATABASE_SSL=false
MIGRATE_ON_START=true
TEMPLATE_KEYS=1:$(head -c 32 /dev/urandom | base64)
SIGNUP_ENABLED=true
RUN_WORKER=true
WEB_DIST_DIR=$APP_DIR/web/dist
# Email: pick ONE option, then: systemctl restart attendance
EMAIL_TRANSPORT=log
EMAIL_FROM=Attendance <attendance@$DOMAIN>
# --- Gmail (Google Account > Security > 2-Step Verification > App passwords)
# EMAIL_TRANSPORT=smtp
# SMTP_HOST=smtp.gmail.com
# SMTP_PORT=465
# SMTP_SECURE=true
# SMTP_USER=you@gmail.com
# SMTP_PASS=your-16-char-app-password
# EMAIL_FROM=Attendance <you@gmail.com>
# --- Resend (free tier ~3,000 emails/month; needs a domain you own)
# EMAIL_TRANSPORT=resend
# RESEND_API_KEY=re_xxx
ENV
  umask 022
fi
OWNER_PW=$(sed -n 's#^MIGRATION_DATABASE_URL=postgres://att_owner:\([^@]*\)@.*#\1#p' "$ENV_FILE")
APP_PW=$(sed -n 's#^DATABASE_URL=postgres://att_app:\([^@]*\)@.*#\1#p' "$ENV_FILE")
MIGRATION_URL=$(sed -n 's#^MIGRATION_DATABASE_URL=##p' "$ENV_FILE")
[ -n "$OWNER_PW" ] && [ -n "$APP_PW" ] || die "could not read DB passwords from $ENV_FILE"

log "Creating database roles and database"
sudo -u postgres psql -v ON_ERROR_STOP=1 -q <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='att_owner') THEN CREATE ROLE att_owner LOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='att_app') THEN CREATE ROLE att_app LOGIN; END IF;
END \$\$;
ALTER ROLE att_owner PASSWORD '$OWNER_PW';
ALTER ROLE att_app PASSWORD '$APP_PW';
SQL
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='attendance'" | grep -q 1 || sudo -u postgres createdb -O att_owner attendance
sudo -u postgres psql -q -d attendance -c 'CREATE EXTENSION IF NOT EXISTS pgcrypto'

# --------------------------------------------------------------------------- app
log "Installing the application into $APP_DIR"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP_DIR"
for part in server web; do
  rm -rf "${APP_DIR:?}/${part:?}.new"
  mkdir -p "$APP_DIR/$part.new"
  (cd "$SRC_DIR/$part" && tar --exclude=node_modules --exclude=dist -cf - .) | tar -xf - -C "$APP_DIR/$part.new"
done
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

log "Building (a few minutes on a small VPS)"
sudo -u "$APP_USER" env PATH="$PATH" HOME="$APP_DIR" npm_config_cache="$APP_DIR/.npm" bash -c "
  set -e
  cd '$APP_DIR/server.new' && npm ci --no-audit --no-fund && npm run build && npm prune --omit=dev
  cd '$APP_DIR/web.new' && npm ci --no-audit --no-fund && NODE_OPTIONS=--max-old-space-size=512 npm run build && rm -rf node_modules
"
for part in server web; do
  rm -rf "${APP_DIR:?}/${part:?}.old"
  if [ -d "$APP_DIR/$part" ]; then mv "$APP_DIR/$part" "$APP_DIR/$part.old"; fi
  mv "$APP_DIR/$part.new" "$APP_DIR/$part"
done

log "Running database migrations"
sudo -u "$APP_USER" env PATH="$PATH" MIGRATION_DATABASE_URL="$MIGRATION_URL" APP_DB_ROLE=att_app \
  bash -c "cd '$APP_DIR/server' && node dist/migrate.js"

# --------------------------------------------------------------------------- systemd
cat > /etc/systemd/system/attendance.service <<UNIT
[Unit]
Description=Restaurant Attendance (API + worker + dashboard)
After=network-online.target postgresql.service
Wants=network-online.target
Requires=postgresql.service

[Service]
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_DIR/server
EnvironmentFile=$ENV_FILE
ExecStart=/opt/node/bin/node --max-old-space-size=192 dist/server.js
Restart=always
RestartSec=3
MemoryMax=400M
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable attendance >/dev/null 2>&1
systemctl restart attendance

# --------------------------------------------------------------------------- caddy (automatic HTTPS)
log "Configuring HTTPS for $DOMAIN"
mkdir -p /var/www/attendance-downloads && chmod 755 /var/www/attendance-downloads
{
  if [ -n "$LE_EMAIL" ]; then printf '{\n\temail %s\n}\n\n' "$LE_EMAIL"; fi
  cat <<CADDY
$DOMAIN {
	encode zstd gzip
	# Kiosk APK downloads for in-app updates: copy APKs into /var/www/attendance-downloads
	handle_path /downloads/* {
		root * /var/www/attendance-downloads
		file_server
	}
	reverse_proxy 127.0.0.1:8080 {
		flush_interval -1
	}
}
CADDY
} > /etc/caddy/Caddyfile
systemctl enable caddy >/dev/null 2>&1
systemctl reload caddy 2>/dev/null || systemctl restart caddy

# --------------------------------------------------------------------------- firewall + backups
log "Firewall (SSH, HTTP, HTTPS only) and nightly backups"
ufw allow OpenSSH >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; ufw --force enable >/dev/null
install -m 0755 "$SRC_DIR/deploy/vps/backup.sh" /usr/local/bin/attendance-backup
install -m 0755 "$SRC_DIR/deploy/vps/update.sh" /usr/local/bin/attendance-update
echo "15 3 * * * root /usr/local/bin/attendance-backup >> /var/log/attendance-backup.log 2>&1" > /etc/cron.d/attendance-backup
systemctl enable --now cron >/dev/null 2>&1 || true

# --------------------------------------------------------------------------- verify
log "Waiting for the service"
for _ in $(seq 1 30); do curl -fsS http://127.0.0.1:8080/readyz >/dev/null 2>&1 && break; sleep 2; done
curl -fsS http://127.0.0.1:8080/readyz >/dev/null || { journalctl -u attendance -n 50 --no-pager; die "service did not become ready"; }
if journalctl -u attendance -n 200 --no-pager | grep -q "Row-level security is NOT enforced"; then
  echo "WARNING: row-level security not enforced — check DATABASE_URL uses att_app"
fi

cat <<DONE

==========================================================================================
 Restaurant Attendance is running.

   Dashboard:   https://$DOMAIN   (first visit can take ~30 s while the certificate is issued)
   Health:      https://$DOMAIN/readyz
   Config:      $ENV_FILE   <- BACK THIS FILE UP (TEMPLATE_KEYS + DB passwords)
   Logs:        journalctl -u attendance -f
   Backups:     /var/backups/attendance (nightly 03:15, 14 days kept) — copy them off the server too
   Update:      cd <repo>/attendance && git pull && sudo attendance-update
   Rollback:    sudo attendance-update --rollback
   APK hosting: /var/www/attendance-downloads  ->  https://$DOMAIN/downloads/<file>.apk

 Next steps:
   1. Open the dashboard on your phone and create your restaurant account.
   2. Set up email in $ENV_FILE (Gmail app password or Resend), then: systemctl restart attendance
   3. Private server for one restaurant? Set SIGNUP_ENABLED=false and restart.
   4. Install the kiosk APK and pair it (Dashboard > Devices > Add kiosk).
==========================================================================================
DONE
