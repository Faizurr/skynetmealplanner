# Operating cost estimates

> **Indicative estimates, not quotes.** Provider prices change, and promotions and tax (Malaysia SST on digital services)
> vary. Check each provider's pricing page before buying. Figures use USD list-price tiers as generally published by
> these providers, converted at an **assumed** US$1 ≈ RM 4.4.

## Cheapest option: single VPS (recommended for one restaurant)

| Item | Cost |
|---|---|
| 1 GB VPS (budget provider annual promo, Google Cloud free-tier e2-micro — [GCP_FREE_TIER.md](GCP_FREE_TIER.md) — or Oracle Cloud Always Free) | ≈ US$0–3 / month |
| Domain (optional; free `sslip.io` / DuckDNS hostname works) | US$0 – ≈ US$1 / month |
| Email via Gmail SMTP app password (≈500/day) or Resend free tier | US$0 |
| HTTPS certificate (Let's Encrypt via Caddy) | US$0 |
| App distribution (PWA + sideloaded APK, no app stores) | US$0 |
| **Total** | **≈ US$0–4 / month (≈ RM 0–18)** + one-off tablet RM 600–1,200 |

Setup: [VPS_DEPLOY.md](VPS_DEPLOY.md). Trade-offs vs managed hosting: you handle OS updates and off-site backups, the
VPS is a single point of failure (kiosks keep working offline), and budget hosts vary in reliability. A 1 GB VPS
comfortably serves one restaurant and likely several small ones (the app uses ≈ 85 MB RAM). For the larger scenarios
below, move to a bigger VPS (2–4 GB, ≈ US$5–12/month) before moving to managed services.

## Why it is cheap to run

- **Face recognition runs on the tablet**: no per-recognition cloud fees and no video upload. Each event sends about 1 KB.
- **No LLM**: insights are deterministic calculations. LLM cost is zero.
- **One small container + one Postgres database** serve many restaurants. Attendance data is tiny: about 1 KB per event,
  so 100 staff × 2 events × 365 days ≈ 75 MB/year including indexes.
- **Email** is the main cost that grows with headcount. "Important events only" plus the daily summary keeps it small.

## Assumptions

- Hosting: Render (Singapore). Starter instance ≈ US$7/mo; Standard ≈ US$25/mo. Fly.io and Railway are comparable.
- Database: Neon. The free tier is fine for a pilot but has limited history/backups. A paid plan (≈ US$19/mo "Launch"
  class) gives point-in-time restore. Supabase Pro ≈ US$25/mo is comparable.
- Email: Resend. Free ≈ 3,000 emails/month (100/day cap). Pro ≈ US$20/mo for 50,000. Amazon SES ≈ US$0.10 per 1,000
  emails is the cheapest at volume.
- Per-event emails = 2 per employee per working day. Important-only mode ≈ late + missing check-out + alerts + 1 daily summary.
- Domain: ≈ US$10–15/yr (.com) or ≈ RM 80–150/yr (.my).
- Kiosk hardware (one-time): an Android 10+ tablet with a decent front camera, RM 600–1,200, plus a wall/stand mount RM 80–250.
- Monitoring: free tiers (e.g. UptimeRobot / Better Stack free) are enough to start.

## Scenarios (monthly, recurring)

| Scenario | Hosting | Database | Email | Other | **Total / month** |
|---|---|---|---|---|---|
| 1. One restaurant, one kiosk (~15 staff) | US$7 | US$0 (free tier, pilot) – US$19 (with PITR) | US$0 (≈30/day fits free tier) | domain ≈ US$1 | **≈ US$8–27 (RM 35–120)** |
| 2. One restaurant, several kiosks (~30 staff) | US$7 | US$19 | US$0 if important-only; US$20 if every check-in/out is emailed (~60/day nears the cap) | ≈ US$1 | **≈ US$27–47 (RM 120–210)** + RM 700–1,450 one-off per extra tablet |
| 3. ~100 employees | US$7–25 | US$19 | US$20 for per-event emails (~200/day exceeds the free cap); US$0 if important-only | ≈ US$1 | **≈ US$27–65 (RM 120–290)** |
| 4. Ten branches (~250 staff, 10–15 kiosks) | US$25 | US$19–69 | US$20 (≈15k/month per-event) or US$0–20 important-only | monitoring US$0–20 | **≈ US$65–135 (RM 290–590)** |
| 5. ~1,000 employees, multiple branches | US$50 (2 instances) | US$69+ (more compute/storage) | Per-event emailing (~60k/month) ≈ US$35–90 on Resend, or ≈ US$6 on SES; important-only + digests recommended | monitoring/log retention US$20–50 | **≈ US$145–260 (RM 640–1,150)** |

## What increases costs

- Emailing every check-in/out to several recipients (multiply by the number of addresses).
- Longer backup retention, PITR windows, and read replicas.
- Dashboards kept open on many screens: each holds an SSE connection. That's cheap, but count it when you size instances.
- Very large exports over long ranges (CPU spikes): schedule them off-peak.
- Replacing kiosk tablets (budget about 3 years per device in a busy kitchen environment).
- Optional upgrades: a certified liveness SDK (licence fees per device or per verification), MDM for unattended updates
  (≈ US$1–4 per device/month), Google Play managed distribution.

## What it does **not** need

No GPU, no cloud face API, no LLM subscription, no app-store fees (the PWA installs from the browser; the APK is sideloaded
or MDM-pushed). An Apple Developer account (US$99/yr) is only needed if you later want a native iOS app.
