# Attendance Kiosk (Android)

Front-desk kiosk app for the restaurant attendance system. Employees tap **CHECK IN** or
**CHECK OUT**, look at the front camera, and the server records the event. Contract:
[`../docs/API.md`](../docs/API.md) (Kiosk API section).

## Architecture

```
android/
├── core/   pure Kotlin/JVM: all platform-independent logic + JUnit 5 tests
│   ├── api/       DTOs (kotlinx.serialization), KioskApi (OkHttp, blocking), ApiResult
│   ├── face/      EmbeddingCodec (128×float32 LE base64, L2), Matcher (port of server identify()),
│   │              FrameGate (single face, ≥80 px), RecognitionSession (consensus, duplicates, tracking)
│   ├── liveness/  HeadTurnChallenge (YuNet landmarks → yaw ratio)
│   ├── flow/      AttendanceFlow state machine, LastActionGuard, PinValidator
│   ├── queue/     OfflineQueue (device-time order, dedupe, retry classification, backoff), encrypted store
│   ├── crypto/    AES-256-GCM ByteCipher, SecureBlobStore (one file per record, atomic temp+rename)
│   ├── update/    UpdatePolicy (version / sha256 / package / certificate rules), ApkDownloader
│   ├── enroll/    EnrollmentCapture (5 poses, quality + consistency rules)
│   ├── pairing/   pairing-code normalisation, server URL validation
│   └── format/    display strings (same formats as the server)
└── app/    Android application (Compose, Material 3, CameraX, OpenCV)
    ├── face/      FaceEngine (YuNet + SFace via OpenCV Java API), FrameConverter, ModelInstaller
    ├── camera/    CameraPreview (CameraX PreviewView + ImageAnalysis in Compose)
    ├── data/      KioskRepository (network, caches, heartbeat/sync/refresh loops), Keystore key, stores
    ├── update/    UpdateManager (download, verify, PackageInstaller session), InstallResultReceiver
    └── ui/        theme tokens, Home / Camera / Success / PIN / Pairing screens, Manager mode
```

`settings.gradle.kts` includes `:app` only when an Android SDK is found (`ANDROID_HOME`,
`ANDROID_SDK_ROOT` or `local.properties` `sdk.dir`), so `./gradlew :core:test` works on machines
without the Android SDK or Google's Maven repository.

### Recognition pipeline

Identical to `tools/face-eval/eval.py`: frame → upright BGR, long side ≤ 640 px → YuNet
(`FaceDetectorYN`, score 0.8, NMS 0.3) → exactly one face, shorter side ≥ 80 px → SFace
`alignCrop` + `feature` → L2-normalise → 1:N cosine match against the cached templates
(`/api/kiosk/templates`, ETag) with the server's rule: best ≥ `match_threshold` (default 0.50)
and best − second-best employee ≥ `match_margin` (0.06). See `docs/FACE_EVAL_RESULTS.md`.

A match is accepted only after **3 consecutive agreeing frames** (frames with cosine > 0.995 to
the previous frame are skipped as duplicates; a different face resets the streak). Analysis runs
at ≤ 8 fps on one background thread and stops as soon as a match is accepted; the request is sent
exactly once. The server re-verifies the embedding and never trusts the kiosk's match alone.
If no confident match is reached the kiosk says *"We don't recognise you yet…"* and sends
`/api/kiosk/unknown-face` — it never guesses.

### Liveness (software only — not foolproof)

When `liveness_required` is on, the employee is asked to turn their head LEFT or RIGHT (random)
and back. Yaw ratio = (noseX − eyeMidX) / eyeDistance must pass ±0.18 in the requested direction
and return within ±0.08 inside 8 s, with the same face tracked throughout (embedding similarity
≥ 0.6) and a face box that is not perfectly static. This stops printed photos and casual misuse,
but **a video of the employee turning their head, a good mask, or a determined attacker can
defeat it**. It is a deterrent, not a security boundary; the owner still gets reviewable records.

### Offline mode

If the server is unreachable (no connectivity, timeout, 5xx) and `offline_mode_enabled`, a face
attempt that passed local consensus (+ liveness when required) is saved to the encrypted queue
(one AES-GCM file per event, Android Keystore key) and the employee sees *"Saved on this device —
will sync when online"* with the **device** time. A local last-action guard blocks obvious wrong
actions offline. The queue is replayed in device-time order every 30 s and on reconnect:
2xx → removed (embedding deleted), 4xx → moved to the failed list (shown in Manager mode with the
reason; the server has already alerted the owner), 5xx/network → exponential backoff (30 s … 30 min).
PIN attendance is never queued.

### Credentials on the device

The only stored credential is the device token from pairing, encrypted with an AES-256-GCM key
held in the Android Keystore. The manager token is kept in memory only (15 min max, 3 min idle).
No service keys, database or SMTP credentials exist in the app.

## Build

Prerequisites: JDK 17, Android SDK (platform 35, build-tools), internet access to Google Maven.

```bash
# 1. Face models (once): downloads YuNet + SFace into attendance/models and checks SHA-256
attendance/scripts/fetch-models.sh

# 2. Unit tests of the shared logic (no Android SDK needed)
cd attendance/android
./gradlew :core:test

# 3. Debug APK
./gradlew :app:assembleDebug

# 4. Release APK (R8 minified). Version from Gradle properties:
export KIOSK_KEYSTORE_PATH=/secure/kiosk-release.jks
export KIOSK_KEYSTORE_PASSWORD=...
export KIOSK_KEY_ALIAS=kiosk
export KIOSK_KEY_PASSWORD=...
./gradlew :app:assembleRelease -PkioskVersionCode=12 -PkioskVersionName=1.2.0
# → app/build/outputs/apk/release/app-release.apk
```

The build copies the two `.onnx` files from `attendance/models/` into the APK assets and fails
with a clear message if they are missing. At first start the app copies them to internal storage
and verifies their SHA-256 before OpenCV loads them.

Signing values can also come from `android/keystore.properties` (gitignored):

```properties
storeFile=/secure/kiosk-release.jks
storePassword=...
keyAlias=kiosk
keyPassword=...
```

If no signing configuration is present, `assembleRelease` produces an **unsigned** APK
(`app-release-unsigned.apk`); sign it with `apksigner sign --ks kiosk-release.jks app-release-unsigned.apk`.

### Create the release keystore (once — keep it safe and backed up)

```bash
keytool -genkeypair -v -keystore kiosk-release.jks -alias kiosk \
  -keyalg RSA -keysize 4096 -validity 10000
```

All future updates must be signed with the same key: installed kiosks refuse updates signed by
any other certificate.

### Signing certificate SHA-256 (needed when publishing releases)

```bash
apksigner verify --print-certs app-release.apk | grep 'SHA-256'
# or
keytool -list -v -keystore kiosk-release.jks -alias kiosk | grep 'SHA256:'
```

## Install

* `adb install -r app/build/outputs/apk/release/app-release.apk`, or
* copy the APK to the tablet and open it (allow "Install unknown apps" for the file manager).

Recommended hardware: Android 8.0+ (API 26) tablet with a front camera, mounted at face height,
with even lighting in front of the employee (avoid a bright window behind them).

## Pairing

1. Dashboard → Devices → Add kiosk → note the pairing code (e.g. `K7Q-4MX-29P`, valid 15 min).
2. On the kiosk enter the server address (`https://…`) and the code (case and spaces don't matter).
3. The kiosk stores its device token (encrypted) and shows the home screen.

HTTPS is mandatory in release builds. Debug builds additionally accept `http://` for
`10.0.2.2`, `localhost`, `127.0.0.1` and `192.168.x.x` test servers.
If the owner revokes the device, the kiosk returns to the pairing screen.

## Manager mode

Press and hold the small gear (top right) for about a second, then sign in with an owner or
manager account. The session ends after 15 minutes or 3 minutes without interaction.

* **Enroll / re-enroll** – see below.
* **Offline queue** – pending and failed records with reasons; *Sync now*.
* **Device info** – device, restaurant, server, version, model checksums, last sync, camera test.
* **Check for updates** – see below.
* **Settings** – kiosk lock (screen pinning) and a local sound override.
* **Unpair** – removes the token, caches and the offline queue (warns if records are unsynced).

### Enrollment procedure

1. Choose the employee (search by name or staff ID; the list shows enrollment status).
2. Show the employee the **privacy notice** (what is collected — a numeric template, not a photo;
   purpose; retention; deletion; the PIN alternative; who to contact).
3. Record **how consent was given** (written form / acknowledged on screen / verbal, witnessed),
   tick *Employee agrees*, and optionally *store a reference photo*.
4. Capture **5 samples**: look straight, slightly left, slightly right, closer, normal. Each must be a
   single face ≥ 100 px and sharp; inconsistent sample sets are rejected before upload.
5. Optional reference photo (JPEG ≤ 200 KB), only if ticked.
6. **Confirm identity** ("I confirm this person is Sarah Lim (S001)") and save.
7. **Test recognition** with a fresh capture (`/api/kiosk/manager/verify`).

Errors: *face already enrolled* (the face matches another employee — remove that enrollment first)
and *inconsistent samples* (capture again with better light and only the employee in frame).

## Publishing an update

1. Build and sign the release with a higher `kioskVersionCode`.
2. Upload the APK to an HTTPS location (e.g. object storage / CDN).
3. On the server:
   ```bash
   cd attendance/server
   npm run create-release -- --apk ./app-release.apk \
     --url https://downloads.example.com/kiosk-1.2.0.apk \
     --version-code 12 --version-name 1.2.0 --cert-sha256 <SHA-256 from apksigner> \
     [--min 10] [--notes "What's new"]
   ```
   `--min` marks older versions as requiring the update (stronger banner).

Kiosks check daily (and from Manager mode → Check for updates). Before installing, the kiosk
verifies: HTTPS URL, file SHA-256 = `apk_sha256`, package name = its own, version code = release
and newer than installed, and signing certificate = `signing_cert_sha256` **and** = the installed
app's own certificate. Only then is the APK handed to the Android package installer; otherwise the
reason is shown and the current version keeps running.

On normal (consumer) devices Android always asks a person to confirm the installation, and the app
must be allowed to "Install unknown apps" (the update screen links to that setting). **Silent,
unattended updates are only possible on a device managed via Android Enterprise / an MDM (device
owner, dedicated device mode)** — distribute updates through the MDM in that case. Stop kiosk lock
before installing an update on a pinned (non-managed) device. After an update, reopen the app if
the system does not bring it back.

## Kiosk lockdown recommendations

* Simple: Manager mode → Settings → *Start kiosk lock* (Android screen pinning). In Android
  settings enable "Ask for PIN before unpinning".
* Best: enroll the tablet in an MDM / Android Enterprise as a **dedicated device** and allow-list
  this app for lock task mode (`android:lockTaskMode="if_whitelisted"` is set), set it as the only
  app, disable the status bar, and push updates via the MDM.
* Keep the tablet on power, disable automatic screen lock, and point it at a well-lit spot.

## Known limitations

* Software liveness only (see above). No depth/IR anti-spoofing.
* Recognition accuracy depends on camera, lighting and enrollment quality; tune `match_threshold`
  per site with the on-site evaluation procedure (`tools/face-eval`).
* Offline records show the device time and are flagged as offline on the server; a wrong device
  clock is flagged as clock skew for review.
* Offline mode needs at least one successful template sync while online.
* The head-turn direction assumes CameraX delivers the front-camera analysis frames unmirrored
  (CameraX default); `LivenessConfig.framesMirrored` switches the sign if a device differs.
* Lint is not enforced on release builds yet (`checkReleaseBuilds = false`); run `./gradlew :app:lint`.
