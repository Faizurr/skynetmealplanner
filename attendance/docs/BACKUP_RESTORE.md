# Backup & restoration

## What to back up

| Asset | How | Why |
|---|---|---|
| PostgreSQL database | Provider automated backups + point-in-time recovery (PITR), plus a weekly logical dump | All business data |
| `TEMPLATE_KEYS` | Password manager / secret manager, 2 copies | Without it, encrypted face templates are unreadable (staff would need re-enrolment; attendance data is unaffected) |
| APK signing keystore + passwords | Offline, 2 secure locations | Without it you can never ship updates to installed kiosks (reinstall needed) |
| `.env` / host variables | Secret manager | Rebuild the service |

## Recommended policy

- Managed provider: daily automated backups, **7–30 days PITR**, encrypted at rest (Neon, Supabase, RDS and Render Postgres
  all offer this on paid plans; free tiers have limited or no PITR, so check yours).
- Weekly logical dump stored in a separate account/region (encrypted).
- **Quarterly restore drill** into a scratch database, then run the smoke checks below.

## Logical backup (verified procedure)

```bash
# Dump (custom format, compressed). Use the OWNER role URL.
pg_dump --format=custom --no-owner --no-privileges \
  --file attendance-$(date +%F).dump "$MIGRATION_DATABASE_URL"

# Encrypt before storing off-site (example with age or gpg)
gpg --symmetric --cipher-algo AES256 attendance-$(date +%F).dump
```

## Restore

```bash
# 1. Create an empty database and the two roles (deploy/db-roles.sql) on the target server.
# 2. Restore as the owner role:
pg_restore --no-owner --role=att_owner --dbname "$TARGET_OWNER_URL" attendance-YYYY-MM-DD.dump
# 3. Re-apply runtime grants (idempotent) and pending migrations:
MIGRATION_DATABASE_URL="$TARGET_OWNER_URL" APP_DB_ROLE=att_app npm run migrate:prod   # from attendance/server
# 4. Point DATABASE_URL / MIGRATION_DATABASE_URL at the restored DB with the SAME TEMPLATE_KEYS and restart.
```

`pg_restore` may report one ignored error, `COMMENT ON EXTENSION pgcrypto`, when the restoring role is not a superuser. It is harmless.

Smoke checks after restore: `/readyz` is ok; sign in; Today shows the expected data; a kiosk heartbeat appears under
Devices; a test check-in records and appears live; Settings → Notifications → Send test email reaches `sent`.

This dump-and-restore round trip (including the grant step) was executed against PostgreSQL 16 in the development
environment, and row counts matched. See [TEST_RESULTS.md](TEST_RESULTS.md).

## Point-in-time recovery

Use your provider's PITR to restore to a new branch/instance at a time just before the incident, verify it, then switch
`DATABASE_URL`. Do not restore over the live database.

## Kiosk-side data

Unsynced offline events live in the kiosk's encrypted queue until they sync. Before wiping, replacing or unpairing a
kiosk, open Manager mode → Offline queue and make sure **Pending = 0**.
