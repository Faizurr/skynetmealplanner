# Troubleshooting

## Kiosk

| Symptom | Likely cause | Fix |
|---|---|---|
| "Face not recognised" for an enrolled employee | Backlight, glasses/cap, poor enrolment, enrolment still *pending confirmation* | Improve lighting; re-enrol in Manager mode (5 samples, good light); confirm pending enrolments in the dashboard (Staff → Enrollment review); use PIN meanwhile |
| "Only one person at a time" | Another face is visible (people queuing behind) | Ask others to step back; adjust the tablet angle |
| "You're already checked in" | Employee pressed CHECK IN instead of CHECK OUT | Go back and press CHECK OUT. The app never switches the action automatically |
| "You are not checked in" on CHECK OUT | Missed check-in, or a session closed automatically after the maximum shift length | Manager adds a correction in the dashboard (Attendance → Add missing session) |
| "CHECK OUT is available after a minute" | Accidental double tap protection (`min_minutes_between_in_and_out`) | Wait a minute or adjust the setting |
| Head-turn prompt never completes | Turning too fast/too little, or face partly out of frame | Turn slowly until the prompt changes, then look straight. Owner may disable liveness (not recommended) |
| Offline banner, "Saved on this device" | No internet | Events sync automatically. Check Wi-Fi. Manager mode → Offline queue shows pending/failed items |
| Item in "Failed" sync list | Server could not accept an offline event (e.g. employee deactivated) | Owner sees a *sync failure* alert in the dashboard; add a correction if needed |
| "This device has been revoked" / pairing screen appears | Device revoked or re-paired in the dashboard | Devices → Add kiosk (or Re-pair) and enter the new code |
| Camera error / black preview | Camera used by another app, permission denied | Close other apps; Android Settings → Apps → Attendance Kiosk → Permissions → Camera → Allow; restart app |
| Update fails "signature mismatch" | APK signed with a different keystore | Build with the original keystore. If lost, uninstall/reinstall + re-pair (empty the queue first) |

## Dashboard

| Symptom | Fix |
|---|---|
| Live feed not updating ("Reconnecting") | Check internet. Proxies must not buffer `/api/stream` (nginx: `proxy_buffering off`). Reload the page |
| Can't sign in, "account locked" | Wait 15 minutes, or another owner resets via Team (remove + re-invite) |
| Test email stays *queued* / *failed* | Settings → Notifications → delivery log shows the provider error: check `EMAIL_TRANSPORT`, API key / SMTP credentials, verified sender domain (SPF/DKIM). *Suppressed* = email is disabled on the server |
| No emails at quiet hours | Expected: they are delayed until quiet hours end (security alerts are not delayed) |
| Times look shifted | Settings → Restaurant time zone (default Asia/Kuala_Lumpur) |
| Employee shows "Absent" but worked | Their check-in wasn't linked to the scheduled shift (e.g. a manual entry far outside the window). Add/adjust a correction |
| Installed iPhone app shows old version | Close and reopen. When prompted, tap *Reload* |

## Server / operations

| Symptom | Fix |
|---|---|
| Startup warning "Row-level security is NOT enforced" | `DATABASE_URL` uses the owner or superuser role. Create `att_app` (deploy/db-roles.sql) and use it |
| `Invalid configuration: TEMPLATE_KEYS…` | Must be `1:<base64 of exactly 32 bytes>`, e.g. `1:$(openssl rand -base64 32)` |
| `template key version N not configured` | A key was removed while templates still use it. Restore it in `TEMPLATE_KEYS` |
| `/readyz` 503 | Database unreachable: check `DATABASE_URL`, SSL (`DATABASE_SSL=true` for managed DBs), IP allow-lists |
| Migrations fail with permission errors | Run them with `MIGRATION_DATABASE_URL` (owner role); `pgcrypto` may need to be created by the provider admin |
| Logs | Structured JSON (pino). Request auth headers and cookies are redacted |
