# Restaurant Attendance Platform

Face-recognition attendance for restaurants:

- **Android kiosk app**: the employee taps **CHECK IN** or **CHECK OUT**, and only then does the camera open. The face is
  recognised on the device, the server validates the action, and a confirmation appears.
- **Owner dashboard (PWA)**: install it on iPhone, Android or desktop. Live attendance, staff, shifts, alerts,
  corrections, insights, reports, email notifications.
- **Cloud backend**: Node + PostgreSQL. A single source of truth with row-level tenant isolation, immutable attendance
  events, an audit trail, and realtime updates.

```
attendance/
  server/     API + worker + migrations + tests        → docs/API.md, docs/ARCHITECTURE.md
  web/        Owner PWA (React + Vite)
  android/    Kiosk app (Kotlin, Compose, CameraX, OpenCV YuNet + SFace)
  tools/face-eval/  Recognition pipeline check on public photos
  docs/       Everything else (below)
```

## Quick start (local)

```bash
bash attendance/scripts/dev-db.sh                 # PostgreSQL 16 must be running locally
bash attendance/scripts/fetch-models.sh           # face models (SHA-256 verified)
cd attendance/server && npm ci && npm test        # 47 tests against real PostgreSQL
DATABASE_URL=postgres://att_app:app_pw@localhost:5432/attendance_dev \
  TEMPLATE_KEYS="1:$(openssl rand -base64 32)" EMAIL_TRANSPORT=log npm run dev
cd ../web && npm ci && npm run dev                # dashboard at http://localhost:5173
```

## Documentation

| Topic | File |
|---|---|
| Architecture, decisions, diagram, data model | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| User flows (kiosk, owner, offline, corrections) | [docs/USER_FLOWS.md](docs/USER_FLOWS.md) |
| API reference | [docs/API.md](docs/API.md) |
| Face recognition: engine choice, thresholds, liveness limits, on-site evaluation | [docs/FACE_RECOGNITION.md](docs/FACE_RECOGNITION.md), [docs/FACE_EVAL_RESULTS.md](docs/FACE_EVAL_RESULTS.md) |
| Security, privacy (PDPA) & pre-production checklist | [docs/SECURITY_PRIVACY.md](docs/SECURITY_PRIVACY.md), [docs/PRIVACY_NOTICE_TEMPLATE.md](docs/PRIVACY_NOTICE_TEMPLATE.md) |
| Metric definitions | [docs/ANALYTICS.md](docs/ANALYTICS.md) |
| **Cheapest: one US$1–3 VPS, one-command install** | [docs/VPS_DEPLOY.md](docs/VPS_DEPLOY.md) |
| Deployment (managed hosting) & environment variables | [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md), [.env.example](.env.example) |
| APK build, install, pairing, enrolment, updates | [docs/APK_INSTALL.md](docs/APK_INSTALL.md), [android/README.md](android/README.md) |
| Installing the dashboard on iPhone/Android | [docs/PWA_INSTALL.md](docs/PWA_INSTALL.md) |
| Backup & restoration | [docs/BACKUP_RESTORE.md](docs/BACKUP_RESTORE.md) |
| Operating costs | [docs/COSTS.md](docs/COSTS.md) |
| Troubleshooting | [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) |
| Test results | [docs/TEST_RESULTS.md](docs/TEST_RESULTS.md) |
| Known limitations & remaining work | [docs/LIMITATIONS.md](docs/LIMITATIONS.md) |
