# User flows

## Employee: check in / check out (kiosk)

```
Home (CHECK IN | CHECK OUT, clock, online status) — camera OFF
  └─ tap CHECK IN ──▶ buttons lock · event id created
        Camera (front) · "Position your face inside the frame." · CANCEL always visible
          ├─ CANCEL ───────────────────────────────▶ Home (nothing recorded)
          ├─ 0 faces → keep guiding · >1 face → "One person at a time" · small → "Come closer"
          ├─ liveness: "Turn your head LEFT" → "Look straight"
          ├─ 3 agreeing frames ≥ threshold & margin ─▶ submit (once)
          │     ├─ 200 recorded ─▶ Success: "Good morning, Sarah!" · CHECK-IN SUCCESSFUL · 9:02 am · date ─(N s)─▶ Home
          │     ├─ 409 already_checked_in ─▶ "You're already checked in since 9:02 am" ─▶ [Back to home]
          │     ├─ 422 not recognised (server) ─▶ Retry / Use PIN / Cancel
          │     └─ network down ─▶ queue encrypted ─▶ "Saved on this device — will sync" ─▶ Home
          └─ no confident match before timeout ─▶ "We don't recognise you yet…" (owner alerted) ─▶ Retry / PIN / Home
CHECK OUT is symmetric. Success shows the recorded duration (break rules applied).
```

## Employee without face enrolment (or who declines)

Home → "Use staff PIN" → choose CHECK IN/OUT → staff ID + PIN → same server rules → success/wrong-action screens.
Five wrong PINs lock the PIN for 15 minutes.

## Unknown person

Recognition fails → no event, nothing guessed → `unknown_face` alert (no image) emailed to the owner (max 1 per kiosk per
10 minutes) → owner/manager enrols the person in Manager mode if they are new staff.

## Owner: first-time setup

1. Open the dashboard URL → **Create account** (restaurant name, your name, email, password). This creates the restaurant,
   a "Main" branch, and you as owner. Notifications go to your email by default.
2. **Shifts** → create schedules (overnight supported, grace, unpaid break).
3. **Staff** → add employees, assign shifts, optionally set PINs.
4. **Devices** → Add kiosk → pairing code → enter it on the tablet.
5. Kiosk → Manager mode → **Enroll** each employee (privacy notice, consent, 5 samples, confirm identity, test).
6. Watch **Today** and the **Live** feed update as staff check in. Emails arrive per your notification settings.

## Owner: daily use (mobile first)

Today: who's working, who's late or not here yet, needs-attention list → Live feed → Alerts (missing check-outs, unknown
faces, offline kiosks, items to review) → fix with corrections → Insights/Reports at month end (CSV timesheet marked provisional).

## Corrections

Any role can **request** a correction (adjust times, add a missing session, void). Owners/managers **approve**, or apply
directly with a reason. The original events never change. Corrected values are layered on the session, and every step is in
the audit log.

## Offline kiosk

Kiosk offline → enrolled employees still recognised on-device → events queued encrypted (device time) → dashboard shows
the kiosk as offline (email after 15 min) and does **not** show those events yet → connection returns → events replay in
order, each re-verified by the server → conflicts become **Awaiting review** with an alert → the offline alert resolves.

## Employee leaves

Staff → employee → **Deactivate**. Face data is deleted automatically, attendance history is kept, and the kiosk
template list refreshes.
