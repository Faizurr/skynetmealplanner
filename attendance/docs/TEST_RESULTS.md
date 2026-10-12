# Test results

Actual results only. Where something could not be executed, it says so and why.

## Summary

| Area | Where run | Result |
|---|---|---|
| Backend unit + integration tests (real PostgreSQL 16, non-owner role so RLS applies) | Dev environment, and GitHub Actions (`attendance-server`) | **50 / 50 pass** locally (3 consecutive full runs on the final code); CI run #2 **success** |
| Owner PWA: typecheck, unit tests, build | Dev environment + GitHub Actions (`attendance-web`) | tsc 0 errors · **23 / 23** vitest pass · build OK · CI run #2 **success** |
| Owner PWA end-to-end (Playwright, Chromium, real backend serving the built PWA with strict CSP) | Dev environment | **4 / 4** pass (390×844 & 1440×900, light & dark); 50 screenshots in `docs/screenshots/` |
| Android kiosk `:core` logic (JUnit) | Dev environment + GitHub Actions | **144 / 144** pass (14 classes) |
| Android `:app` compile, unit tests, lint, debug + release APK | GitHub Actions (`attendance-android`) | **BUILD SUCCESSFUL in 2m 55s**; `app-debug.apk` (debug-signed, installable) and `app-release-unsigned.apk` produced |
| Face pipeline (YuNet + SFace, same OpenCV APIs as the kiosk) on public photos | Dev environment | 0 wrong-person acceptances; see [FACE_EVAL_RESULTS.md](FACE_EVAL_RESULTS.md) |
| Backup → restore round trip | Dev environment (PostgreSQL 16) | Row counts matched; app role queried the restored DB |
| VPS / GCP install scripts | Dev environment | `bash -n` + shellcheck: no warnings. **Not executed on a real server** (no systemd here) |
| Server memory | Dev environment | ≈ 85 MB RSS after 500 requests |

## Backend (server/test)

Run: `cd attendance/server && TEST_PG_ADMIN_URL=postgres://postgres@localhost:5432/postgres npm test`

**Unit (15):** KL time-zone conversion and DST correctness; lateness with grace; overnight shifts crossing midnight
(occurrence, lateness, duration 22:00→06:30 = 7h30 worked after break, 30 min overtime); multiple shifts per day
(claimed-shift tracking); unscheduled days and effective dates; break threshold and overtime; settings fallback and
rounding; 1:N identification (accept, unknown → reject, near-identical "twins" → ambiguous, no templates); embedding
codec and malformed input; AES-GCM template encryption bound to the employee (row swap and tamper both fail); scrypt and
pairing codes; quiet hours wrapping midnight; important-only filter; HTML escaping (no injected images); CSV formula
injection; email backoff cap.

**Integration (35, real PostgreSQL):**
- Auth: signup provisioning; wrong password; lockout after repeated failures; CSRF header required; attendance_admin
  cannot manage biometrics/devices/team; last owner cannot be demoted.
- Devices: single-use pairing code; revoked device locked out; expired code rejected.
- Enrollment: manager session required; consent required; inconsistent samples rejected; **one face cannot be enrolled
  under two employees**; templates stored encrypted; re-enrolment replaces templates; pending enrolment unusable until the
  owner confirms.
- Attendance: CHECK IN records exactly one verified event with server time, lateness and greeting; the same event id
  re-sent → duplicate, no new row; CHECK IN while checked in → `already_checked_in` (never converted to a check-out);
  CHECK OUT right after → `too_soon`; CHECK OUT duration from real timestamps with break rules (546 min − 30 min break);
  CHECK OUT without a session → `no_active_session`; unknown face never assigned and alert deduplicated; a kiosk claiming a
  different employee → refused and flagged; liveness enforced; **two kiosks checking in at once → exactly one event**;
  4 concurrent copies of one event id → recorded once; PIN fallback and lockout after 5; events immutable and undeletable,
  audit log unalterable (as the runtime DB role); manual owner-assisted attendance.
- Offline: device time preserved, sync time recorded separately, idempotent re-upload; conflicting offline check-out →
  `pending_review` + alert, owner approval; future device clock flagged and clamped; rejected offline event → sync-failure
  alert + email instead of vanishing.
- Lifecycle: suspension blocks attendance; deactivation deletes biometrics and keeps attendance; explicit biometric deletion;
  PDPA export excludes templates.
- **Tenant isolation:** restaurant B gets 404 on A's employee read/update/delete/photo; B's kiosk cannot recognise A's
  staff; B's manager cannot open A's kiosk manager mode; as the runtime DB role, no tenant context → 0 rows, B's context
  cannot see A's rows or templates, and inserting into A is blocked by row-level security.
- Corrections: original times untouched, corrected values layered, audit entries, cannot decide twice, add-session creates
  manual events.
- Email: delivered over **real SMTP** to a local SMTP server (employee name, staff ID, event type present; no image parts);
  unreachable SMTP → queued with error and backoff; retry succeeds; no resend on the next run; test email reports real
  status `sent`.
- Worker: missing check-out flagged once and kept open for a late check-out; offline kiosk alerted once and resolved by
  heartbeat; daily summary queued once; disabled transport recorded as `suppressed`, never as `sent`.
- Dashboard data: overview/analytics/CSV reflect real records; formula injection neutralised; **SSE stream delivers the
  committed check-in to a connected dashboard**; app-update endpoint (newer / mandatory / https-only).
- Regression: overnight shift started yesterday appears on today's roster as late; feed cursor does not skip events with
  identical timestamps; static serving returns 404 for missing hashed assets and serves new build files without restart.

Bugs found and fixed by these tests during development: a correction response sent before its transaction committed;
a SQL parameter type error on employee status changes; the worker re-flagging sessions on every tick; overnight shifts
missing from "Today"; feed paging skipping same-timestamp events; stale-asset fallback after deploys.

## Owner PWA (web/)

`npm run typecheck` (0 errors) · `npx vitest run` (23 tests: time-zone formatting, status mapping — `pending_review` never
shown as Verified, API client CSRF/error/401 handling) · `npm run build` (precache 38 entries; service worker has
`denylist: [/^\/api\//]` and no API runtime caching).

Playwright `e2e/smoke.spec.ts` against the real backend serving `web/dist`: sign up → shift → employee → manual check-in
→ pairing code (format, countdown) → live feed updates **without reload** when an event is created from another API
session → event detail → Today/Timesheets/Alerts/kiosk settings render → Insights CSV download contains PROVISIONAL.
Fails on any console error/CSP violation (only the expected pre-login 401 is allowed) and on horizontal overflow at 390 px.

Not exercised end-to-end (need the kiosk): offline-synced / awaiting-review / rejected kiosk events and enrollment
confirm/reject in the browser (implemented and unit-tested; backend paths covered by integration tests).

## Android kiosk (android/)

`:core` — 144 JUnit tests: AttendanceFlow 35, RecognitionSession 17, KioskApi (MockWebServer) 13, OfflineQueue 13,
HeadTurnChallenge 12, UpdatePolicy 10, Matcher 8, DisplayFormat 7, EmbeddingCodec 6, LastActionGuard 6,
EnrollmentCapture 5, Pairing 5, Crypto 4, ManagerSession 3. The matcher and codec are checked against 240 fixtures
generated by running the server's own `face.ts`.

`:app` — compiled, unit-tested and linted on GitHub Actions; debug APK signed with the CI debug key
(SHA-256 `96c7d9a7…7788e`, changes per runner — not suitable for in-app updates); release APK unsigned until keystore
secrets are added. The "APK contents" CI step (run #3, passed) confirmed in both APKs: `assets/models/face_detection_yunet_2023mar.onnx`
(232,589 B) and `face_recognition_sface_2021dec.onnx` (38,696,353 B — byte sizes match the SHA-256-pinned models),
`libopencv_java4.so` for arm64-v8a and armeabi-v7a, package `com.attendance.kiosk` versionCode 1 / 1.0.0, targetSdk 35,
permissions CAMERA, INTERNET, ACCESS_NETWORK_STATE, REQUEST_INSTALL_PACKAGES, launcher `MainActivity`, and no
secret-like strings in the dex. Sizes: debug 139 MB, release 129 MB (all ABIs bundled; an arm64-only split would roughly
halve this).

**Not yet tested:** running the APK on a physical device (camera, recognition, liveness direction, offline queue on a real
network drop, update install). No emulator was available (no KVM) and the build environment cannot reach Google's Android
servers.
