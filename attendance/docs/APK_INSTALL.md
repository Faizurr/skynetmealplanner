# Kiosk app: build, install, pair, update

## 1. Get the APK

**Option A — GitHub Actions (recommended).** The workflow `.github/workflows/attendance-android.yml` builds the debug and
release APKs on every change to `attendance/android/` (Actions → *attendance-android* → artifact `kiosk-apks-…`).
For a **signed** release, add these repository secrets once:

| Secret | Value |
|---|---|
| `KIOSK_KEYSTORE_BASE64` | `base64 -w0 kiosk-release.jks` |
| `KIOSK_KEYSTORE_PASSWORD` | keystore password |
| `KIOSK_KEY_ALIAS` | e.g. `kiosk` |
| `KIOSK_KEY_PASSWORD` | key password |

Create the keystore once (keep it safe; losing it means installed kiosks can't be updated):
```bash
keytool -genkeypair -v -keystore kiosk-release.jks -alias kiosk -keyalg RSA -keysize 4096 -validity 10000
keytool -list -v -keystore kiosk-release.jks -alias kiosk | grep SHA256   # signing cert SHA-256 (for releases)
```

**Option B — local build** (needs the Android SDK, JDK 17):
```bash
bash attendance/scripts/fetch-models.sh
cd attendance/android
KIOSK_KEYSTORE_PATH=/path/kiosk-release.jks KIOSK_KEYSTORE_PASSWORD=... KIOSK_KEY_ALIAS=kiosk KIOSK_KEY_PASSWORD=... \
  ./gradlew :app:assembleRelease -PkioskVersionCode=1 -PkioskVersionName=1.0.0
# → app/build/outputs/apk/release/app-release.apk
```

## 2. Prepare the tablet

- Android 8.0+ (Android 10+ recommended) with a front camera, mounted at face height, facing away from bright windows.
- Connect to the restaurant Wi-Fi. Keep it on a charger.
- Set an Android screen-lock PIN known only to the owner/manager (this protects Android settings).

## 3. Install

- **USB**: `adb install app-release.apk`
- **Sideload**: copy the APK to the tablet (download link, USB, Google Drive) → open it → allow *Install unknown apps* for
  that source when Android asks → Install.

## 4. Pair with your restaurant

1. Dashboard → **Devices → Add kiosk** → give it a name (e.g. "Front door").
2. On the tablet, open **Attendance Kiosk**, enter your dashboard address (`https://…`) and the **pairing code** shown in the
   dashboard (valid 15 minutes).
3. The kiosk shows the CHECK IN / CHECK OUT home screen. The dashboard shows it as **Online**.

## 5. Enrol employees (Manager mode)

1. On the kiosk, open the gear → sign in with an owner/manager account.
2. **Enroll employee** → choose the employee (create them first in the dashboard under Staff).
3. Show the employee the privacy notice and record consent (signed form / on-screen acknowledgement / witnessed verbal).
4. Capture the 5 guided samples → confirm identity → **Test recognition**.
5. Employees who decline: set a **PIN** in the dashboard (Staff → employee → Set PIN). They use "Use staff PIN" on the kiosk.

## 6. Lock the tablet to the app

- Simple: Manager mode → Settings → **Kiosk lock** (Android screen pinning). Unpinning requires the device PIN.
- Managed fleet: enrol the tablets in an MDM (Android Enterprise "dedicated device"/kiosk mode, e.g. Google's Android
  Management API partners, Scalefusion, Hexnode, ManageEngine). This also allows **unattended updates**.

## 7. Updates

1. Build a signed APK with a **higher** `versionCode`, signed with the **same** keystore.
2. Upload it to an HTTPS URL and register it (`npm run create-release`, see [DEPLOYMENT.md](DEPLOYMENT.md)).
3. On the kiosk: Manager mode → **Check for updates** (it also checks daily). The app downloads the APK and verifies:
   file SHA-256 = published value; package name = this app; versionCode is newer; signing certificate = the published
   certificate = the certificate of the installed app. Only then does it open the Android installer. A manager taps
   **Update**. Silent installation is not possible on ordinary consumer devices; it needs MDM device-owner mode.
4. **If an update fails**: the current version keeps running. Retry from Manager mode, or install the APK manually over USB
   (`adb install -r app-release.apk`). Same signature = data and pairing are kept. As a last resort, uninstall and
   reinstall, then re-pair (make sure the offline queue is empty first).
