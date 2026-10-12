# Running on Google Cloud's free tier

Google Cloud's "Always Free" tier includes one **e2-micro** VM (2 shared vCPUs, 1 GB RAM) per month in **us-west1
(Oregon), us-central1 (Iowa) or us-east1 (South Carolina)**, a **30 GB standard persistent disk**, and a limited amount
of outbound traffic per month (about 1 GB from North America to most destinations). The app uses about 85 MB RAM, so
it fits. The installer is the same one used for any VPS ([VPS_DEPLOY.md](VPS_DEPLOY.md)).

> Check Google's current free-tier terms before relying on them, and set a budget alert. Free-tier rules change, and
> anything outside them (another region, an SSD/balanced disk, a second VM, extra traffic, possibly the external IPv4
> address) is billed. I have **not** run this on your account. This environment has no access to your Google Cloud,
> and that is intentional.

## One-time setup (≈ 15–25 minutes, mostly waiting)

1. Open **Google Cloud Shell**: https://shell.cloud.google.com (already signed in, nothing to install).
2. Select your project: `gcloud config set project YOUR_PROJECT_ID` (billing must be enabled on the project, even for
   free-tier usage).
3. Run:
   ```bash
   git clone -b claude/restaurant-attendance-system https://github.com/Faizurr/skynetmealplanner.git
   bash skynetmealplanner/attendance/deploy/gcp/create-free-vm.sh
   # Optional: ZONE=us-central1-a  DOMAIN=attendance.yourdomain.com  LE_EMAIL=you@example.com  STATIC_IP=true
   ```
   This enables Compute Engine, opens ports 80/443, and creates an e2-micro Ubuntu 24.04 VM with a 30 GB standard disk.
   The VM then installs everything by itself on first boot.
4. Watch the install (the script prints the exact command):
   `gcloud compute ssh attendance --zone us-west1-b --command 'sudo tail -f /var/log/attendance-install.log'`
5. When it says **"Restaurant Attendance is running"**, open the printed `https://…sslip.io` (or your domain) on your phone
   → **Create account**.
6. Save the server secrets to your password manager:
   `gcloud compute ssh attendance --zone us-west1-b --command 'sudo cat /etc/attendance.env'`
7. **Billing → Budgets & alerts**: create a budget of e.g. US$1 with email alerts.

If the repository is private, Cloud Shell will ask you to authenticate the clone. The VM's startup script also clones it,
so either make the repository public, or SSH into the VM and run the clone + `deploy/vps/install.sh` manually
([VPS_DEPLOY.md](VPS_DEPLOY.md), step 3).

## Email on free tier

Google Cloud blocks outbound port **25**. Ports **465/587** (Gmail SMTP, other providers) and HTTPS APIs (Resend) work.
Edit `/etc/attendance.env` on the VM (`sudo nano /etc/attendance.env`), fill the Gmail app-password block, then
`sudo systemctl restart attendance` and send a test email from Settings → Notifications.

## Things to know

- **Latency**: the free regions are in the US. That's about 170–230 ms from Malaysia. Fine for attendance: kiosk requests
  are tiny, recognition runs on the tablet, and kiosks queue offline anyway. Dashboards feel slightly slower than with a
  Singapore server.
- **Traffic**: one restaurant uses well under the free allowance. Kiosk heartbeats are about 45 MB/month per kiosk; the
  dashboard loads once and then is cached; email delivery traffic is negligible. Many owners opening the dashboard
  often, or many kiosks, can exceed it. Watch the billing report.
- **IP address**: the default external IP is *ephemeral*. It survives reboots but **changes if you stop and start** the
  VM, which changes the `sslip.io` address (kiosks would need re-pairing). Avoid this with a domain/DuckDNS pointed at the
  IP, or `STATIC_IP=true` (a reserved address may be billed; check the pricing page).
- **Performance**: e2-micro has burstable shared CPU. Install/update builds take 10–20 minutes. Normal operation is light.
- **Backups**: nightly to `/var/backups/attendance` on the same disk. Also copy them off the VM: use rclone to Google
  Drive (see [VPS_DEPLOY.md](VPS_DEPLOY.md)), or create a disk snapshot schedule (snapshots are billed beyond the free tier).
- **Updates**: `gcloud compute ssh attendance --zone us-west1-b`, then
  `cd /root/src/attendance && sudo git pull && sudo attendance-update`.
- **Remove everything**: `gcloud compute instances delete attendance --zone us-west1-b` (+ `gcloud compute firewall-rules delete attendance-allow-web`).
