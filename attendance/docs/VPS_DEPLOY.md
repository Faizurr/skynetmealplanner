# Cheapest setup: one small VPS (≈ US$1–3/month)

Everything runs on one Linux server: PostgreSQL + the app (API, worker, dashboard) + Caddy (automatic HTTPS). The
apps are distributed unofficially: the dashboard installs from the browser (PWA), and the kiosk APK is sideloaded and
updates itself from your own server.

## Will it fit?

Measured in development: the app process uses **≈ 85 MB RAM** after warm-up. With PostgreSQL tuned by the installer
(`shared_buffers=64MB`, 30 connections) and Caddy (≈ 20–40 MB), a **1 GB** VPS has plenty of headroom for one or a few
restaurants. **512 MB** works too: the installer adds 1 GB of swap, but building the dashboard during install/update is
slow on 512 MB. Recommended minimum: 1 vCPU, 1 GB RAM, 10 GB disk, Ubuntu 24.04 / 22.04 or Debian 12, x86_64 or ARM64.
Prefer a **Singapore or Malaysia** location for the lowest latency.

## Where to get a cheap server (check current offers)

- **Oracle Cloud "Always Free"**: free ARM (Ampere) instances with generous RAM, Singapore region available. Needs a card at
  sign-up, and free capacity is sometimes unavailable in a region. US$0.
- **Budget VPS providers with annual promotions**: 1 GB plans are often advertised around US$10–25 per year (≈ US$1–2/month).
  Pick one with a Singapore/Asia location, and read reviews about uptime and support.
- **Mainstream low-cost**: Hetzner (Singapore location), Vultr, DigitalOcean, Linode: ≈ US$4–6/month for 1 GB, with more
  predictable reliability.

Prices change often. Treat these as examples, not quotes.

## Install (about 10 minutes)

1. Create the VPS (Ubuntu 24.04). Note its public IP. SSH in as root.
2. Optional but recommended: point a domain at the IP (A record), e.g. `attendance.yourdomain.com`. No domain? The
   installer uses a free hostname like `203-0-113-10.sslip.io` and still gets a real HTTPS certificate. A free DuckDNS
   name also works.
3. Run:
   ```bash
   apt-get update && apt-get install -y git
   git clone -b claude/restaurant-attendance-system https://github.com/Faizurr/skynetmealplanner.git /root/src
   cd /root/src/attendance
   sudo DOMAIN=attendance.yourdomain.com LE_EMAIL=you@example.com bash deploy/vps/install.sh
   # (omit DOMAIN to use <ip>.sslip.io)
   ```
   If the repository is private, use a GitHub personal access token in the clone URL, or upload a zip of the repository with `scp`.
4. Open the printed `https://…` address on your phone → **Create account**.
5. **Email**: edit `/etc/attendance.env` and pick Gmail SMTP (needs 2-Step Verification + an *App password*; consumer Gmail
   allows about 500 recipients/day) or Resend (free tier, needs your own domain). Then `systemctl restart attendance` and use
   *Settings → Notifications → Send test email*. The delivery log must show **sent**.
6. Single restaurant? Set `SIGNUP_ENABLED=false` in `/etc/attendance.env` and restart.
7. **Back up `/etc/attendance.env`** to your password manager. It holds the face-template key and the DB passwords.

What the installer does: adds swap on small servers; installs PostgreSQL (low-memory tuning), Node.js 22 (checksum
verified) and Caddy; generates secrets once; creates separate DB owner/runtime roles (so row-level security is enforced);
builds and migrates; runs the app as an unprivileged, sandboxed systemd service (`MemoryMax=400M`, auto-restart); sets up
HTTPS, a firewall (22/80/443 only), nightly backups at 03:15 (14 days kept), and `/downloads/` hosting for kiosk APKs.
Re-running it is safe.

> The installer has been syntax-checked and linted (shellcheck, no warnings) but **has not yet been run on a real VPS**.
> The development environment has no systemd. Please report the output if any step fails.

## Day-to-day operations

| Task | Command |
|---|---|
| Status / logs | `systemctl status attendance` · `journalctl -u attendance -f` |
| Update to the latest code | `cd /root/src/attendance && git pull && sudo attendance-update` (backs up first) |
| Roll back the code | `sudo attendance-update --rollback` |
| Manual backup | `sudo attendance-backup` → `/var/backups/attendance/` |
| Off-site backups | `apt install rclone`, `rclone config` (Google Drive/B2), uncomment the last line of `/usr/local/bin/attendance-backup` |
| Restore | see [BACKUP_RESTORE.md](BACKUP_RESTORE.md) (use `sudo -u postgres pg_restore …`) |

## Kiosk APK distribution & updates from the same server

1. Get the APK from GitHub Actions (artifact) or build locally ([APK_INSTALL.md](APK_INSTALL.md)).
2. First install: open `https://<your-domain>/downloads/kiosk-1.0.0.apk` on the tablet (after copying it to
   `/var/www/attendance-downloads/` with `scp`), allow *Install unknown apps* for the browser, then install.
3. Updates: copy the new signed APK (same keystore, higher versionCode) to `/var/www/attendance-downloads/`, then register it:
   ```bash
   cd /opt/attendance/server && set -a && . /etc/attendance.env && set +a
   sudo -E -u attendance node dist/cli/create-release.js --apk /var/www/attendance-downloads/kiosk-1.1.0.apk \
     --url https://<your-domain>/downloads/kiosk-1.1.0.apk --version-code 2 --version-name 1.1.0 \
     --cert-sha256 <signing cert SHA-256> --notes "What changed"
   ```
   The kiosk verifies the SHA-256 and signing certificate before offering the update.

## Limits of a single cheap VPS (be aware)

- **Single point of failure**: if the VPS goes down, the dashboard is down. The kiosks keep working offline and sync later.
  Keep off-site backups. Budget hosts can have weaker uptime and support.
- **No managed point-in-time recovery**: you get nightly dumps, so you could lose up to a day of dashboard-side changes
  (kiosk data still waiting in queues is not lost).
- Keep the OS patched: `apt update && apt upgrade` monthly (or enable `unattended-upgrades`).
- If you use the `sslip.io` hostname and the server IP changes, the URL changes and kiosks must be re-paired. A domain avoids this.
