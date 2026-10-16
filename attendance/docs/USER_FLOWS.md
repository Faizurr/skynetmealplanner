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

Today: who's working, who's late or not here yet, needs-attention list → Pay (what's owed) → Live feed → Alerts (missing check-outs, unknown
faces, offline kiosks, items to review) → fix with corrections → Insights/Reports at month end (CSV timesheet marked provisional).

## Paying salaries (owner sets salaries, manager pays)

1. **Owner → More → Salaries**: tap a staff member and enter the **daily salary** (covers 12 hours). The sheet shows the
   overtime rate (salary ÷ 12) and an example 14-hour day. A new salary can start today or on a future date; days already
   paid never change.
2. When an employee **checks out**, that day's pay is calculated right away: day salary + overtime minutes × hourly rate.
   The dashboard pops up *"Siti checked out · RM 165.63 due [Pay]"* and the Pay tab badge counts what's unpaid.
3. **Pay tab → tap the day** to see the breakdown, then choose:
   - **Cash**: the camera opens. Photograph the signed payslip and confirm. A cash payment can't be saved without the photo.
   - **QR / DuitNow**: confirm; a screenshot of the transfer is optional.
   - **Pay later**: stays pending, optionally with a note ("Friday"). The *Outstanding* total and the *Owed to* chips
     track everything still unpaid, per person.
4. Bonus, advance or deduction: **Adjust amount** with a reason before paying.
5. Mistake? The owner can **Undo payment** (the photo stays on record). If attendance is corrected after a day was paid,
   the payout is flagged **Check** instead of silently changing.
6. Month end: **Export this month (CSV)** at the bottom of Pay.

## Leaderboard

More → Leaderboard: last 7 days / this month / last month. Points: +10 on time, +5 per day worked, −5 late, −10 missed
check-out. Tap **Share** to send a ready-made image (names and points only, no pay) to WhatsApp or Instagram, or copy it
as text.

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
