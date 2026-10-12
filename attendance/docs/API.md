# API reference

Base URL: the server's `PUBLIC_BASE_URL` (e.g. `https://attendance.example.com`). All bodies are JSON.
All timestamps are ISO-8601 UTC strings; local display uses the restaurant `timezone` (default `Asia/Kuala_Lumpur`).

**Errors** always look like `{ "error": "<code>", "message": "<human text>", "details"?: {...} }`.
Validation errors: `400 validation_failed` with `details.issues[] = {path, message}`.

**Auth models**

| Client | Mechanism |
|---|---|
| Owner PWA | HttpOnly cookie `att_session` set by signup/login. Every non-GET request must send header `X-CSRF: 1`. Use `credentials: 'include'`/same-origin fetch. |
| Kiosk device | `Authorization: Bearer <device_token>` obtained once from `/api/kiosk/pair`. |
| Kiosk manager mode | Device bearer **plus** `X-Manager-Token: <token>` from `/api/kiosk/manager/login` (15 min). |

Roles: `owner`, `manager`, `attendance_admin`. `/api/auth/me` returns the `permissions[]` list; hide UI the user cannot use
(`attendance.read, attendance.manual, attendance.review, corrections.request, corrections.approve, employees.read,
employees.write, biometrics.manage, shifts.write, devices.manage, notifications.manage, settings.manage, team.manage,
audit.read, reports.export`). A 403 `forbidden` is returned otherwise.

---

## Auth (PWA)

| Method & path | Body / query | Response |
|---|---|---|
| `POST /api/auth/signup` | `{restaurant_name, branch_name?='Main', timezone?='Asia/Kuala_Lumpur', full_name, email, password(min 10)}` | `201 {ok, restaurant_id}` + cookie. `409 email_taken`, `403 signup_disabled` |
| `POST /api/auth/login` | `{email, password, restaurant_id?}` | `{ok, restaurant_id}` + cookie. `401 invalid_credentials`, `423 account_locked` |
| `POST /api/auth/logout` | – | `{ok}` |
| `GET /api/auth/me` | – | `{user:{id,email,full_name,must_change_password}, role, permissions[], restaurant:{id,name,timezone}, memberships:[{restaurant_id,name,role}]}`; `401 unauthenticated` if not signed in |
| `POST /api/auth/switch` | `{restaurant_id}` | `{ok}` (new cookie) |
| `POST /api/auth/change-password` | `{current_password, new_password}` | `{ok}` |

## Realtime

`GET /api/stream` — Server-Sent Events (cookie auth; use `new EventSource('/api/stream')`).
Events: `ready` (on connect) and `change` with data `{table, op, id}` where table ∈
`attendance_events | attendance_sessions | attendance_exceptions | devices | employees | face_enrollments`.
The client should re-fetch the affected view (debounce ~300 ms). EventSource auto-reconnects (`retry: 3000`).

## Overview & analytics

`GET /api/overview?date=YYYY-MM-DD&branch_id=` →
```
{ date, timezone,
  metrics: { expected_today, currently_working, checked_out, not_yet_arrived, late_not_arrived, absent, late_arrivals,
             missing_checkouts, pending_review, pending_corrections, pending_enrollments, open_exceptions,
             devices_offline, devices_with_unsynced_events },
  exceptions_by_kind: { [kind]: n },
  roster: [{ employee:{id,full_name,staff_id,branch_id,status,job_title},
             status: 'late_not_arrived'|'working'|'unscheduled_working'|'not_yet_due'|'checked_out'|'absent',
             scheduled_start, scheduled_end, shift_name, check_in_at, check_out_at, is_late, late_minutes, worked_minutes }],
  devices: [{id,name,status,last_seen_at,pending_queue_count,app_version,last_error,online}] }
```

`GET /api/analytics?from=YYYY-MM-DD&to=YYYY-MM-DD&branch_id=` (≤400 days) →
```
{ from, to, timezone,
  summary: { scheduled_shifts, attended_scheduled_shifts, total_sessions, punctuality_rate(%|null), late_arrivals,
             late_frequency(%|null), average_lateness_minutes|null, absences, attendance_rate(%|null), missing_checkouts,
             average_worked_minutes|null, total_worked_minutes, total_overtime_minutes },
  daily: [{date, scheduled, attended, late, absences, worked_minutes, sessions, missing_checkouts}],
  by_weekday: [{weekday(1=Mon), name, sessions, late, scheduled_sessions, missing_checkouts, absences, late_rate}],
  arrival_by_hour: [{hour(0-23 local), check_ins, late}],
  by_branch: [{branch_id, name, sessions, late, scheduled_sessions, worked_minutes, missing_checkouts, late_rate}],
  by_shift: [{shift_id, name, sessions, late, missing_checkouts, late_rate}],
  employees: [{employee_id, full_name, staff_id, scheduled, attended, late, absences, worked_minutes, overtime_minutes,
               missing_checkouts, sessions, punctuality_rate, consistency, average_lateness_minutes}],
  absences: [{employee_id, date, shift}],
  insights: [{id, severity:'info'|'warning', title, detail, employee_ids?}] }
```
Insights are only produced when the data supports them; an empty list is normal.

## Attendance

| Method & path | Notes |
|---|---|
| `GET /api/events?from&to(ISO)&employee_id&branch_id&status(verified|pending_review|rejected)&before(ISO cursor)&limit(≤500)&id` | Live feed, newest first. Row: `id, event_type(check_in|check_out), event_time, device_timestamp, server_received_at, source(kiosk_face|kiosk_pin|manual), verification_status, recorded_offline, match_score, exception_flags[], note, session_id, review_note, reviewed_at, employee_id, full_name, staff_id, has_photo, branch_name, device_name, scheduled_start, is_late, late_minutes, worked_minutes, is_corrected, session_status` |
| `GET /api/sessions?from&to(YYYY-MM-DD)&employee_id&branch_id&id` | Timesheet rows: `id, status(open|closed|missing_checkout|voided), employee_id, full_name, staff_id, branch_name, check_in_at, check_out_at, corrected_check_in_at, corrected_check_out_at, effective_check_in, effective_check_out, is_corrected, scheduled_start, scheduled_end, shift_name, late_minutes, is_late, break_minutes, worked_minutes, overtime_minutes, needs_review` |
| `POST /api/attendance/manual` | `{employee_id, action, time?(ISO), note(≥3 chars)}` owner-assisted attendance → `201` AttendanceResult (see kiosk) or same error codes |
| `POST /api/events/:id/review` | `{decision:'approve'|'reject', note?}` for `pending_review` events |
| `GET /api/exceptions?status=open|resolved|all` | Alerts: `id, kind, severity, status, details, created_at, resolved_at, resolution_note, session_id, event_id, employee_id, full_name, staff_id, device_name, device_id`. kinds: `late_arrival, missing_checkout, unknown_face, offline_conflict, clock_skew, device_offline, sync_failure, identity_mismatch, overtime` |
| `POST /api/exceptions/:id/resolve` | `{note?}` |
| `GET /api/corrections?status=requested|approved|rejected|all` | rows incl. `kind, original_values, new_values{check_in_at,check_out_at}, reason, status, full_name, requested_by, decided_by, created_at, decided_at` |
| `POST /api/corrections` | `{kind:'adjust_times'|'add_session'|'void_session', session_id?, employee_id?(add_session), check_in_at?, check_out_at?, reason, apply_now?}` → `201 {id, status:'requested'|'approved'}` (owner/manager may `apply_now`) |
| `POST /api/corrections/:id/approve` / `/reject` | `{note?}` |

## Employees & biometrics

| Method & path | Notes |
|---|---|
| `GET /api/employees?status=active|suspended|deactivated|all&q=&branch_id=` | rows: `id, staff_id, full_name, preferred_name, job_title, department, email, status, branch_id, branch_name, has_pin, has_photo, enrollment:{id,status,created_at,confirmed_at,template_count,consent_method}|null, shifts:[{id,name,start_time,end_time}], open_session:{id,check_in_at}|null` |
| `POST /api/employees` | `{full_name, staff_id, preferred_name?, job_title?, department?, email?, branch_id?, shift_ids?[], pin?(4-8 digits)}` → `201 {employee}`; `409 staff_id_taken` |
| `GET /api/employees/:id` | `{employee, enrollments:[...history]}` |
| `PATCH /api/employees/:id` | any subset of the create fields (except pin) |
| `POST /api/employees/:id/status` | `{status:'active'|'suspended'|'deactivated', delete_biometrics?=true}` |
| `POST /api/employees/:id/pin` | `{pin: '1234' | null}` (fallback PIN for kiosk) |
| `GET /api/employees/:id/photo` | image bytes (consent-gated reference photo), 404 if none |
| `DELETE /api/employees/:id/biometrics` | deletes templates + photo; attendance kept |
| `GET /api/employees/:id/attendance?from&to` | `{sessions[], corrections[]}` |
| `GET /api/employees/:id/export` | PDPA data-access JSON download |
| `GET /api/enrollments?status=pending_confirmation|active|revoked|deleted` | `id, status, created_at, template_count, consent_method, employee_id, full_name, staff_id, has_photo, enrolled_by, device_name` |
| `POST /api/enrollments/:id/confirm` / `/reject` | owner confirms identity before templates become active |

## Configuration

| Method & path | Notes |
|---|---|
| `GET/POST /api/branches`, `PATCH /api/branches/:id` | `{name, address?, timezone?, active?}` |
| `GET /api/shifts`, `POST /api/shifts`, `PUT /api/shifts/:id` | `{name, branch_id?, start_time 'HH:MM', end_time 'HH:MM' (≤ start ⇒ overnight), days_of_week [1..7] (1=Mon), grace_minutes, unpaid_break_minutes, break_applies_after_minutes, overtime_after_minutes|null, active}`; GET rows add `overnight, employee_count` |
| `GET /api/devices` | `{offline_after_minutes, devices:[{id,name,status(pending|active|revoked),branch_id,branch_name,app_version,device_model,last_seen_at,last_sync_at,pending_queue_count,last_error,online,pairing_expires_at,...}]}` |
| `POST /api/devices` | `{name, branch_id?}` → `201 {device_id, pairing_code:'K7Q-4MX-29P', expires_at, server_url}` (15 min, shown once) |
| `POST /api/devices/:id/pairing-code` | new code (invalidates old token) |
| `PATCH /api/devices/:id`, `POST /api/devices/:id/revoke` | |
| `GET /api/settings` / `PUT /api/settings` | `{restaurant:{id,name,timezone}, settings:{match_threshold, match_margin, liveness_required, pin_fallback_enabled, success_return_seconds, sound_enabled, employee_instructions, offline_mode_enabled, max_offline_age_hours, max_clock_skew_minutes, default_unpaid_break_minutes, default_break_applies_after_minutes, default_overtime_after_minutes, max_session_hours, missing_checkout_grace_minutes, min_minutes_between_in_and_out, early_check_in_window_minutes, rounding_minutes(0,1,5,6,10,15,30), rounding_mode(nearest|down|up)}}`. PUT body `{name?, timezone?, settings?: partial}` |
| `GET/PUT /api/notifications/settings` | `{emails[], on_check_in, on_check_out, important_only, late_arrival, missing_checkout, unknown_face, suspicious_events, device_offline, sync_failure, daily_summary, daily_summary_time 'HH:MM', quiet_hours_start|null, quiet_hours_end|null, include_staff_id}`; GET also returns `transport` (smtp/resend/log/disabled) |
| `POST /api/notifications/test` | `{id, status:'queued', transport}` – poll deliveries for the real outcome |
| `GET /api/notifications/deliveries?limit&id` | `id, kind, subject, to_addresses, status(queued|sending|sent|failed|suppressed), attempts, last_error, created_at, sent_at, next_attempt_at, not_before` |
| `POST /api/notifications/deliveries/:id/retry` | |
| `GET/POST /api/team`, `PATCH/DELETE /api/team/:userId` | POST `{email, full_name, role}` → `{user_id, temporary_password|null}` (show once) |
| `GET /api/audit?limit&before(id)&entity_id` | `id, actor_type, actor_name, action, entity_type, entity_id, details, created_at` |

## Reports (CSV downloads, link directly with `<a href download>`)

- `GET /api/reports/timesheet.csv?from&to&employee_id&branch_id&shift_id` — payroll-oriented, first line marks it PROVISIONAL
- `GET /api/reports/events.csv?from&to&employee_id&branch_id`
- `GET /api/reports/summary.csv?from&to&branch_id`

---

## Kiosk API

| Method & path | Body | Response |
|---|---|---|
| `POST /api/kiosk/pair` | `{code, device_model?, app_version?}` | `{device_id, device_token}`; `400 invalid_pairing_code` |
| `GET /api/kiosk/config` | – | `{server_time, restaurant:{id,name,timezone}, branch:{id,name}|null, device:{id,name}, face_model:'opencv-sface-2021dec', settings:{match_threshold, match_margin, liveness_required, pin_fallback_enabled, success_return_seconds, sound_enabled, employee_instructions, offline_mode_enabled, max_offline_age_hours, min_minutes_between_in_and_out}, consent_notice_version}` |
| `GET /api/kiosk/templates` | header `If-None-Match` supported (`304`) | `{model, employees:[{id, full_name, preferred_name, staff_id, templates:[base64 of 128 little-endian float32, L2-normalised]}]}` |
| `POST /api/kiosk/attendance` | see below | AttendanceResult |
| `POST /api/kiosk/unknown-face` | `{action, best_score?}` | `{ok}` (owner alert, no image) |
| `POST /api/kiosk/heartbeat` | `{app_version?, app_version_code?, pending_queue_count, failed_queue_count?, last_error?, synced?}` | `{ok, server_time}` — send every 60 s |
| `POST /api/kiosk/manager/login` | `{email, password}` | `{manager_token, full_name, role, expires_in_seconds:900}`; owner/manager only |
| `GET /api/kiosk/manager/employees` | (manager) | `{employees:[{id, full_name, preferred_name, staff_id, job_title, status, enrollment_status|null}]}` |
| `POST /api/kiosk/manager/enrollments` | (manager) `{employee_id, embeddings:[3..10 base64], consent:{confirmed:true, method:'written_form'|'digital_acknowledgement'|'verbal_witnessed', notice_version}, confirm_identity:boolean, photo_jpeg_base64?}` | `{enrollment_id, status:'active'|'pending_confirmation', employee}`; `422 inconsistent_samples`, `409 face_already_enrolled` |
| `POST /api/kiosk/manager/verify` | (manager) `{embedding}` | `{accepted, reason, score, employee|null}` |
| `GET /api/app/android/latest?current=<versionCode>` | public | `{release:{version_code, version_name, apk_url, apk_sha256, signing_cert_sha256, min_supported_version_code, release_notes, published_at}|null, update_available, mandatory}` |

### `POST /api/kiosk/attendance`
```
{ event_id: uuid (client-generated, reuse on retry → idempotent),
  action: 'check_in' | 'check_out',          // exactly the button the employee tapped
  method: 'face' | 'pin',
  employee_id?: uuid,                        // kiosk's local match (face); server re-verifies
  embedding?: base64 128×float32,            // probe embedding (face), never an image
  match_score?: number, liveness_passed?: boolean,
  staff_id?: string, pin?: '4-8 digits',     // method=pin
  device_timestamp: ISO, offline: boolean }  // offline=true when replaying the local queue
```
**AttendanceResult (200):**
```
{ result: 'recorded' | 'duplicate' | 'pending_review',
  event: { id, type, event_time, verification_status, recorded_offline, exception_flags[], server_received_at },
  employee: { id, full_name, preferred_name, staff_id },
  session: { id, check_in_at, check_out_at, late_minutes, is_late, worked_minutes, break_minutes, overtime_minutes, scheduled_start, scheduled_end } | null,
  display: { greeting: 'Good morning, Sarah!', headline: 'CHECK-IN SUCCESSFUL', time: '9:02 am', date: '12 October 2026', duration: '9h 06m'|null, message } }
```
**Rejections** (no event recorded): `422 not_recognized | ambiguous_match | identity_mismatch | liveness_required`,
`409 already_checked_in (details.check_in_at) | no_active_session | too_soon`, `401 invalid_pin`, `423 pin_locked`,
`403 employee_inactive | pin_disabled | offline_disabled`, `401 device_unauthenticated | device_revoked`.
When replaying offline events, treat 2xx as done, 4xx as permanently failed (the server already raised a `sync_failure`
alert), and 5xx/network errors as retry-later.
