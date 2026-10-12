# Security & privacy plan and pre-production checklist

> This system is **designed to support** compliance with Malaysia's Personal Data Protection Act 2010 (PDPA), as amended
> by the Personal Data Protection (Amendment) Act 2024, and related regulations and guidelines. Technical controls alone
> do **not** make a deployment compliant. Items marked **[Legal/Org]** need review by a qualified adviser and an
> organisational decision before go-live.

## 1. What personal data is processed

| Data | Where | Purpose | Retention (default, configurable by process) |
|---|---|---|---|
| Name, staff ID, job title, department, branch, optional email | `employees` | Attendance, payroll support | Employment + statutory record period |
| Attendance events (time, action, device, verification) | `attendance_events` (immutable) | Attendance records | Employment Act record-keeping period, [Legal/Org] |
| Face templates (128 numbers, encrypted) | `face_templates` | Identify the employee at the kiosk | Until deletion request, re-enrolment or end of employment (deleted automatically on deactivation) |
| Optional reference photo | `employee_photos` | Lets the owner confirm identity at enrolment | Same as templates; deletable on its own |
| Consent record (method, notice version, time, enrolled/confirmed by) | `face_enrollments` | Proof of notice/consent | Kept as metadata after templates are deleted |
| Audit trail | `audit_logs` (append-only) | Accountability, security | [Legal/Org] e.g. 2–7 years |
| Owner/manager accounts | `users`, `user_sessions` | Access control | While account exists |

Biometric data counts as **sensitive personal data** under the PDPA. Processing generally requires explicit consent or
another permitted basis. A **non-biometric alternative** (staff PIN or owner-assisted entry) is always available.

## 2. Implemented technical controls

- **Transport**: HTTPS only in production (`PUBLIC_BASE_URL` must be https), HSTS, Secure + HttpOnly + SameSite=Lax cookies.
  The kiosk refuses cleartext in release builds.
- **Encryption at rest**: face templates use AES-256-GCM with versioned keys (`TEMPLATE_KEYS`, rotation supported) and AAD
  binding to restaurant+employee. Kiosk device token and offline queue use an Android Keystore AES-GCM key. Database disk
  and backups are encrypted by the managed provider (verify in your provider settings) [Org].
- **Authentication**: scrypt password hashes, account lockout after 8 failures (15 min), opaque session tokens stored as
  SHA-256, 14-day sessions, sign-out-everywhere on password change, forced password change for invited users. Kiosks use
  per-device tokens from one-time pairing codes (15-minute expiry, single use) and can be revoked instantly. Kiosk manager
  mode uses owner/manager credentials and a 15-minute token.
- **Authorization**: server-side role checks on every route (owner, manager, attendance_admin). Biometric enrolment and
  deletion are restricted to owner/manager.
- **Tenant isolation**: PostgreSQL row-level security plus composite foreign keys, enforced in the database, and covered by
  automated tests.
- **CSRF**: custom `X-CSRF` header required on cookie-authenticated writes; no CORS is granted.
- **Abuse protection**: global and per-route rate limits (login, pairing, attendance, PIN), PIN lockout after 5 failures.
- **Input validation**: Zod schemas on every endpoint; parameterised SQL only; CSV formula-injection neutralised; HTML
  escaping in emails; strict Content-Security-Policy.
- **Integrity**: attendance events and audit logs are append-only (DB triggers + revoked grants). Corrections are separate,
  approved, audited records.
- **Data minimisation**: the kiosk sends embeddings, never camera frames. Emails never contain photos or templates. Logs
  redact authorization headers, cookies and manager tokens.
- **Secrets**: no secrets in the APK or PWA bundle. All credentials are server-side environment variables. `.env` is gitignored.
- **Deletion**: biometric deletion per employee, automatic deletion on deactivation, and old templates destroyed on re-enrolment.
- **Data access requests**: per-employee JSON export (`/api/employees/:id/export`).
- **Updates**: kiosk installs only APKs that match the published SHA-256 **and** the app's own signing certificate, through
  the Android system installer (user-approved).

## 3. Pre-production checklist

| # | Item | Owner | Status |
|---|---|---|---|
| 1 | Appoint a person responsible for personal data (and a DPO where the amended PDPA requires one) | [Legal/Org] | ☐ |
| 2 | Adopt the employee privacy notice (template: [PRIVACY_NOTICE_TEMPLATE.md](PRIVACY_NOTICE_TEMPLATE.md)) in Bahasa Malaysia **and** English | [Legal/Org] | ☐ |
| 3 | Confirm the lawful basis for biometric processing and the consent wording; make sure refusal has no detriment (PIN alternative) | [Legal/Org] | ☐ |
| 4 | Decide retention periods for attendance, audit logs, consent records; document them | [Legal/Org] | ☐ |
| 5 | Review cross-border transfer: hosting region (Singapore recommended for latency) and email provider location | [Legal/Org] | ☐ |
| 6 | Vendor assessment and data processing agreements with the hosting, database and email providers | [Legal/Org] | ☐ |
| 7 | Review the face model's provenance and licence (SFace via OpenCV Zoo, Apache-2.0) | [Legal] | ☐ |
| 8 | Check employment-law requirements (records, overtime and break rules) against the shift settings | [Legal/Org] | ☐ |
| 9 | Generate production secrets: `TEMPLATE_KEYS` (32 random bytes), DB passwords, email API key; store them in the host's secret manager | Tech | ☐ |
| 10 | Create separate DB roles (`deploy/db-roles.sql`) and confirm the startup log has **no** "Row-level security is NOT enforced" warning | Tech | ☐ |
| 11 | Enable automated daily backups with point-in-time recovery; run a test restore ([BACKUP_RESTORE.md](BACKUP_RESTORE.md)) | Tech | ☐ |
| 12 | Create the APK signing keystore; store it and its passwords offline in two places (losing it breaks updates) | Tech | ☐ |
| 13 | Set `SIGNUP_ENABLED=false` after creating your restaurant (single-restaurant deployments) | Tech | ☐ |
| 14 | Kiosk device: screen lock PIN for Android settings, screen pinning or MDM dedicated mode, OS auto-updates on | Tech | ☐ |
| 15 | Incident response: who to contact, how to revoke kiosks / sessions / rotate keys, breach notification timelines under the amended PDPA | [Legal/Org] | ☐ |
| 16 | Penetration test / security review before onboarding other restaurants (multi-tenant SaaS) | Tech | ☐ |
| 17 | On-site recognition evaluation ([FACE_RECOGNITION.md](FACE_RECOGNITION.md)) | Tech/Org | ☐ |

## 4. Incident response (runbook)

1. **Lost or stolen kiosk**: Dashboard → Devices → Revoke. The device token stops working immediately. Templates cached on
   the kiosk are encrypted with a hardware-backed key and are useless off that device, but treat the event as a potential
   incident [Org].
2. **Compromised owner account**: change the password (this signs out other sessions). Another owner can remove the account
   under Team. Review the audit log.
3. **Suspected template-key exposure**: add a new key version first in `TEMPLATE_KEYS` (`2:NEW,1:OLD`), re-enrol staff (new
   templates use the new key), delete the old enrolments, then remove the old key.
4. **Data breach**: contain, assess, record in the audit/incident log, notify the authority and affected people within the
   timelines required by the amended PDPA [Legal].
5. **Email provider outage**: attendance is unaffected; emails retry for about 4 hours with backoff, then show as `failed`
   with a Retry button.

## 5. Employee rights workflows

- **Access**: Staff → employee → Export data (JSON).
- **Correction**: profile edit; attendance corrections through the correction workflow (audited).
- **Withdraw consent / delete biometrics**: Staff → employee → Delete biometric data (switch to PIN).
- **Offboarding**: Deactivate (deletes biometrics by default; keeps attendance records for the retention period).
