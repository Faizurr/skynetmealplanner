# Known limitations & remaining work

Honest status as of this delivery. "Verified" means an automated test or a real run exercised it; see
[TEST_RESULTS.md](TEST_RESULTS.md).

## Needs real hardware / accounts (cannot be done in the build environment)

| Item | Status | What is needed |
|---|---|---|
| Face recognition on a physical Android tablet | **Not yet tested.** The same YuNet + SFace pipeline was validated in Python on public photos; the kiosk's core matching/liveness logic has 144 unit tests including server-parity fixtures | Install the APK on the target tablet and run the on-site evaluation ([FACE_RECOGNITION.md](FACE_RECOGNITION.md)) |
| Head-turn liveness direction | Assumes front-camera analysis frames are unmirrored; untested on a device | If prompts feel reversed, flip `LivenessConfig.framesMirrored` |
| Signed release APK | CI builds debug + release; release is **unsigned** until you add your keystore as repository secrets | Create keystore ([APK_INSTALL.md](APK_INSTALL.md)) |
| Deployment | Code, Docker, Render blueprint, VPS installer and GCP free-tier script are ready; **nothing is deployed** | A VPS / your Google Cloud project; run the installer |
| VPS installer & GCP script | Syntax-checked + shellcheck clean; **not executed on a real server** (no systemd here) | First run on your server — report any failing step |
| Real email delivery | SMTP delivery, retry and dedupe verified against a local SMTP server; **no real provider tested** | Gmail app password or Resend key |
| Dockerfile | Not built here (no Docker daemon); the steps it runs are covered by CI | `docker build` on any machine |
| PWA install on a real iPhone | Manifest, icons, iOS meta tags and service worker verified in headless Chromium; not tried on a physical iPhone | Open the deployed URL in Safari → Add to Home Screen |

## Product/engineering limitations

- **Software-only liveness** stops printed photos and still images, not determined video replays or masks. A certified
  liveness SDK or depth camera is the upgrade path.
- **Face model licence/provenance** (SFace, Apache-2.0 via OpenCV Zoo) should be reviewed legally before production;
  so should the privacy notice, consent wording and retention periods ([SECURITY_PRIVACY.md](SECURITY_PRIVACY.md)).
- **Legal compliance is not claimed.** The system is designed to support PDPA obligations; the checklist items marked
  [Legal/Org] need professional review.
- **Shift assignments start "today"**; there is no UI to backdate an assignment, so past sessions created before a shift
  was assigned are treated as unscheduled in analytics.
- **Kiosk sync runs while the app is open** (coroutine loop, not WorkManager). Normal for a kiosk that is always open.
- **5xx during a face submit** is treated as "unreachable" and the event goes to the offline queue (re-verified later).
- **Kiosk updates require a manager tap** on ordinary devices; silent installs need MDM device-owner mode.
- **Single VPS** deployments are a single point of failure (kiosks keep working offline) and rely on nightly dumps,
  not point-in-time recovery.
- **SMTP retries after a crash mid-send** can, rarely, duplicate an email (Resend uses an idempotency key; SMTP cannot).
- **Payroll exports are provisional** by design.
- **Native date pickers** in the dashboard show the browser's date format; all other dates use the en-MY format.
- **APK size** is ~130 MB because OpenCV native libraries for three CPU types and the 39 MB recognition model are bundled.
  Building an arm64-only APK (most current tablets) would roughly halve it.
- **Lint** on the Android `:app` module is non-blocking for the first builds (`abortOnError=false`).

## Suggested next steps

1. Install on the target tablet, enrol 3–5 staff, run a week-long pilot with the on-site evaluation.
2. Add your keystore secrets to get a signed APK; publish it via `/downloads/` on your server.
3. Legal review of the privacy notice and the checklist.
4. Optional: backdated shift assignments UI, WorkManager-based background sync, certified liveness, Bahasa Malaysia UI.
