import type { Tx } from './db.js';
import { audit, type Actor } from './audit.js';
import { identify, type TemplateStore } from './face.js';
import { verifySecret } from './crypto.js';
import { resolveSettings, type RestaurantSettings } from './settings.js';
import {
  claimKey,
  computeDuration,
  computeLateness,
  resolveShiftForCheckIn,
  type AssignmentDef,
  type ShiftDef,
} from './shifts.js';
import { formatDate, formatDuration, formatTime, toLocalParts } from './time.js';
import { enqueueNotification, eventEmailRows, renderEmail } from './notifications.js';
import { formatMoney, syncPayoutForSession, type PayoutRow } from './payroll.js';

export type Action = 'check_in' | 'check_out';

export interface AttendanceInput {
  restaurantId: string;
  eventId: string;
  action: Action;
  method: 'face' | 'pin' | 'manual';
  deviceId: string | null;
  branchId: string | null;
  /** Employee the kiosk believes it matched (face) or the owner selected (manual). */
  claimedEmployeeId?: string | null;
  probe?: Float32Array | null;
  deviceMatchScore?: number | null;
  livenessPassed?: boolean | null;
  staffId?: string | null;
  pin?: string | null;
  deviceTimestamp?: Date | null;
  offline: boolean;
  actor: Actor;
  /** Owner-assisted attendance only: the time the owner attests to. */
  manualTime?: Date | null;
  note?: string | null;
  now?: Date;
}

export interface RestaurantCtx {
  id: string;
  name: string;
  timezone: string;
  settings: RestaurantSettings;
  publicBaseUrl: string;
}

export type RejectCode =
  | 'not_recognized'
  | 'ambiguous_match'
  | 'identity_mismatch'
  | 'liveness_required'
  | 'employee_inactive'
  | 'employee_not_found'
  | 'already_checked_in'
  | 'no_active_session'
  | 'too_soon'
  | 'invalid_pin'
  | 'pin_locked'
  | 'pin_disabled'
  | 'offline_disabled'
  | 'event_id_conflict'
  | 'invalid_request';

export class AttendanceRejected extends Error {
  constructor(
    public readonly code: RejectCode,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export interface AttendanceResult {
  result: 'recorded' | 'duplicate' | 'pending_review';
  event: {
    id: string;
    type: Action;
    event_time: string;
    verification_status: 'verified' | 'pending_review' | 'rejected';
    recorded_offline: boolean;
    exception_flags: string[];
    server_received_at: string;
  };
  employee: { id: string; full_name: string; preferred_name: string | null; staff_id: string };
  session: {
    id: string;
    check_in_at: string;
    check_out_at: string | null;
    late_minutes: number;
    is_late: boolean;
    worked_minutes: number | null;
    break_minutes: number;
    overtime_minutes: number;
    scheduled_start: string | null;
    scheduled_end: string | null;
  } | null;
  display: { greeting: string; headline: string; time: string; date: string; duration: string | null; message: string };
}

export async function loadRestaurant(tx: Tx, restaurantId: string, publicBaseUrl: string): Promise<RestaurantCtx> {
  const r = await tx.query<{ id: string; name: string; timezone: string; settings: unknown }>(
    'SELECT id, name, timezone, settings FROM restaurants WHERE id = $1',
    [restaurantId],
  );
  const row = r.rows[0];
  if (!row) throw new Error('restaurant not found');
  return { id: row.id, name: row.name, timezone: row.timezone, settings: resolveSettings(row.settings), publicBaseUrl };
}

interface EmployeeRow {
  id: string;
  full_name: string;
  preferred_name: string | null;
  staff_id: string;
  status: 'active' | 'suspended' | 'deactivated';
  branch_id: string | null;
  pin_hash: string | null;
  pin_failed: number;
  pin_locked_until: Date | null;
}

interface SessionRow {
  id: string;
  employee_id: string;
  branch_id: string | null;
  status: string;
  check_in_at: Date;
  check_out_at: Date | null;
  shift_id: string | null;
  scheduled_start: Date | null;
  scheduled_end: Date | null;
  late_minutes: number;
  is_late: boolean;
  worked_minutes: number | null;
  break_minutes: number;
  overtime_minutes: number;
}

const EMPLOYEE_COLS = 'id, full_name, preferred_name, staff_id, status, branch_id, pin_hash, pin_failed, pin_locked_until';
const SESSION_COLS =
  'id, employee_id, branch_id, status, check_in_at, check_out_at, shift_id, scheduled_start, scheduled_end, late_minutes, is_late, worked_minutes, break_minutes, overtime_minutes';

export async function loadAssignments(tx: Tx, employeeId: string): Promise<AssignmentDef[]> {
  const r = await tx.query<ShiftDef & { effective_from: string; effective_to: string | null }>(
    `SELECT s.id, s.name, s.start_time::text, s.end_time::text, s.days_of_week, s.grace_minutes,
            s.unpaid_break_minutes, s.break_applies_after_minutes, s.overtime_after_minutes,
            a.effective_from, a.effective_to
       FROM shift_assignments a JOIN shifts s ON s.id = a.shift_id
      WHERE a.employee_id = $1 AND s.active`,
    [employeeId],
  );
  return r.rows.map(({ effective_from, effective_to, ...shift }) => ({ shift, effective_from, effective_to }));
}

export async function loadShift(tx: Tx, shiftId: string | null): Promise<ShiftDef | null> {
  if (!shiftId) return null;
  const r = await tx.query<ShiftDef>(
    `SELECT id, name, start_time::text, end_time::text, days_of_week, grace_minutes, unpaid_break_minutes,
            break_applies_after_minutes, overtime_after_minutes FROM shifts WHERE id = $1`,
    [shiftId],
  );
  return r.rows[0] ?? null;
}

function greetingFor(at: Date, tz: string, action: Action, name: string): string {
  if (action === 'check_out') return `See you next time, ${name}!`;
  const h = toLocalParts(at, tz).hour;
  const part = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  return `${part}, ${name}!`;
}

function sessionDto(s: SessionRow | null): AttendanceResult['session'] {
  if (!s) return null;
  return {
    id: s.id,
    check_in_at: s.check_in_at.toISOString(),
    check_out_at: s.check_out_at?.toISOString() ?? null,
    late_minutes: s.late_minutes,
    is_late: s.is_late,
    worked_minutes: s.worked_minutes,
    break_minutes: s.break_minutes,
    overtime_minutes: s.overtime_minutes,
    scheduled_start: s.scheduled_start?.toISOString() ?? null,
    scheduled_end: s.scheduled_end?.toISOString() ?? null,
  };
}

function buildResult(
  r: RestaurantCtx,
  result: AttendanceResult['result'],
  ev: {
    id: string;
    event_type: Action;
    event_time: Date;
    verification_status: 'verified' | 'pending_review' | 'rejected';
    recorded_offline: boolean;
    exception_flags: string[];
    server_received_at: Date;
  },
  emp: Pick<EmployeeRow, 'id' | 'full_name' | 'preferred_name' | 'staff_id'>,
  session: SessionRow | null,
): AttendanceResult {
  const name = emp.preferred_name || emp.full_name.split(' ')[0];
  const pending = ev.verification_status === 'pending_review';
  const headline = pending
    ? 'RECORDED — AWAITING MANAGER REVIEW'
    : ev.event_type === 'check_in'
      ? 'CHECK-IN SUCCESSFUL'
      : 'CHECK-OUT SUCCESSFUL';
  const duration =
    ev.event_type === 'check_out' && session?.worked_minutes != null && session.check_out_at
      ? formatDuration(session.worked_minutes)
      : null;
  const message = pending
    ? 'Your attendance was saved and will be confirmed by a manager.'
    : ev.event_type === 'check_in'
      ? session?.is_late
        ? `Checked in ${session.late_minutes} min after your scheduled start.`
        : 'Have a great shift!'
      : 'Thanks for your hard work today.';
  return {
    result,
    event: {
      id: ev.id,
      type: ev.event_type,
      event_time: ev.event_time.toISOString(),
      verification_status: ev.verification_status,
      recorded_offline: ev.recorded_offline,
      exception_flags: ev.exception_flags,
      server_received_at: ev.server_received_at.toISOString(),
    },
    employee: { id: emp.id, full_name: emp.full_name, preferred_name: emp.preferred_name, staff_id: emp.staff_id },
    session: sessionDto(session),
    display: {
      greeting: greetingFor(ev.event_time, r.timezone, ev.event_type, name),
      headline,
      time: formatTime(ev.event_time, r.timezone),
      date: formatDate(ev.event_time, r.timezone),
      duration,
      message,
    },
  };
}

async function raiseException(
  tx: Tx,
  restaurantId: string,
  e: {
    kind: string;
    severity: 'info' | 'warning' | 'critical';
    dedupeKey: string;
    employeeId?: string | null;
    sessionId?: string | null;
    eventId?: string | null;
    deviceId?: string | null;
    details?: Record<string, unknown>;
  },
): Promise<boolean> {
  const r = await tx.query(
    `INSERT INTO attendance_exceptions (restaurant_id, kind, severity, dedupe_key, employee_id, session_id, event_id, device_id, details)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (restaurant_id, dedupe_key) DO NOTHING`,
    [restaurantId, e.kind, e.severity, e.dedupeKey, e.employeeId ?? null, e.sessionId ?? null, e.eventId ?? null, e.deviceId ?? null, e.details ?? {}],
  );
  return (r.rowCount ?? 0) > 0;
}
export { raiseException };

async function branchName(tx: Tx, branchId: string | null): Promise<string | null> {
  if (!branchId) return null;
  const r = await tx.query<{ name: string }>('SELECT name FROM branches WHERE id = $1', [branchId]);
  return r.rows[0]?.name ?? null;
}

/** Marks a stale open session as missing its checkout and raises the exception + email once. */
/**
 * Flags a session whose checkout is missing. close=true (session exceeded the maximum
 * length) closes it as missing_checkout so the employee can check in again; close=false
 * (past scheduled end + grace) keeps it open so a late checkout still works.
 */
export type { SessionRow };
export async function flagMissingCheckout(
  tx: Tx,
  r: RestaurantCtx,
  s: SessionRow,
  emp: { full_name: string; staff_id: string },
  reason: string,
  close = true,
) {
  await tx.query(
    close
      ? `UPDATE attendance_sessions SET status = 'missing_checkout', needs_review = true, updated_at = now() WHERE id = $1 AND status = 'open'`
      : `UPDATE attendance_sessions SET needs_review = true, updated_at = now() WHERE id = $1 AND status = 'open' AND NOT needs_review`,
    [s.id],
  );
  const created = await raiseException(tx, r.id, {
    kind: 'missing_checkout',
    severity: 'warning',
    dedupeKey: `missing_checkout:${s.id}`,
    employeeId: s.employee_id,
    sessionId: s.id,
    details: { check_in_at: s.check_in_at.toISOString(), scheduled_end: s.scheduled_end?.toISOString() ?? null, reason },
  });
  if (created) {
    const bname = await branchName(tx, s.branch_id);
    await enqueueNotification(tx, r.id, r.timezone, 'missing_checkout', `missing_checkout:${s.id}`, (ns) =>
      renderEmail({
        restaurantName: r.name,
        heading: `Missing check-out: ${emp.full_name}`,
        intro: `${emp.full_name} checked in but has no recorded check-out. Please review and correct the record if needed.`,
        rows: [
          ...eventEmailRows(ns, { employeeName: emp.full_name, staffId: emp.staff_id, type: 'Check-in without check-out', at: s.check_in_at, tz: r.timezone, branch: bname, status: 'Missing check-out' }),
        ],
        link: { href: `${r.publicBaseUrl}/#/attendance?session=${s.id}`, label: 'Review in dashboard' },
      }),
    );
  }
}

/**
 * The attendance state machine. The requested action always comes from the button the
 * employee tapped; the server only decides whether that action is allowed. It never
 * converts a CHECK IN into a CHECK OUT (or vice versa).
 */
export async function recordAttendance(
  tx: Tx,
  r: RestaurantCtx,
  templates: TemplateStore,
  input: AttendanceInput,
): Promise<AttendanceResult> {
  const now = input.now ?? new Date();
  const settings = r.settings;

  // 1. Idempotency: the client-generated event id makes retries and offline re-uploads safe.
  const existing = await tx.query(
    `SELECT e.id, e.event_type, e.event_time, e.verification_status, e.recorded_offline, e.exception_flags,
            e.server_received_at, e.employee_id, e.session_id
       FROM attendance_events e WHERE e.id = $1`,
    [input.eventId],
  );
  if (existing.rows[0]) {
    const ev = existing.rows[0];
    if (ev.event_type !== input.action) {
      throw new AttendanceRejected('event_id_conflict', 'This event id was already used for a different action.');
    }
    const emp = (await tx.query<EmployeeRow>(`SELECT ${EMPLOYEE_COLS} FROM employees WHERE id = $1`, [ev.employee_id])).rows[0];
    const sess = ev.session_id
      ? (await tx.query<SessionRow>(`SELECT ${SESSION_COLS} FROM attendance_sessions WHERE id = $1`, [ev.session_id])).rows[0] ?? null
      : null;
    return buildResult(r, 'duplicate', ev, emp, sess);
  }

  if (input.offline && !settings.offline_mode_enabled) {
    throw new AttendanceRejected('offline_disabled', 'Offline attendance is disabled for this restaurant.');
  }

  // 2. Identity verification.
  let employeeId: string;
  let matchScore: number | null = null;
  let source: 'kiosk_face' | 'kiosk_pin' | 'manual';
  const flags: string[] = [];

  if (input.method === 'face') {
    source = 'kiosk_face';
    if (!input.probe) throw new AttendanceRejected('invalid_request', 'A face embedding is required.');
    if (settings.liveness_required && !input.livenessPassed) {
      throw new AttendanceRejected('liveness_required', 'Liveness check was not completed. Please try again.');
    }
    const sets = await templates.get(r.id, tx);
    const match = identify(input.probe, sets, settings.match_threshold, settings.match_margin);
    if (!match.accepted || !match.employeeId) {
      const code = match.reason === 'ambiguous' ? 'ambiguous_match' : 'not_recognized';
      throw new AttendanceRejected(code, code === 'ambiguous_match'
        ? 'We could not tell who you are with enough certainty. Please try again or use your staff PIN.'
        : 'Face not recognised. Please try again, use your staff PIN, or ask a manager.', {
        score: Number(match.score.toFixed(4)),
      });
    }
    if (input.claimedEmployeeId && input.claimedEmployeeId !== match.employeeId) {
      // The kiosk's local match disagrees with the server's: never record, flag for review.
      await raiseException(tx, r.id, {
        kind: 'identity_mismatch',
        severity: 'critical',
        dedupeKey: `identity_mismatch:${input.eventId}`,
        employeeId: input.claimedEmployeeId,
        deviceId: input.deviceId,
        details: { claimed: input.claimedEmployeeId, server_match: match.employeeId, score: match.score },
      });
      throw new AttendanceRejected('identity_mismatch', 'Identity could not be confirmed. Please try again.');
    }
    employeeId = match.employeeId;
    matchScore = match.score;
  } else if (input.method === 'pin') {
    source = 'kiosk_pin';
    if (!settings.pin_fallback_enabled) throw new AttendanceRejected('pin_disabled', 'PIN attendance is disabled.');
    if (!input.staffId || !input.pin) throw new AttendanceRejected('invalid_request', 'Staff ID and PIN are required.');
    const emp = (
      await tx.query<EmployeeRow>(`SELECT ${EMPLOYEE_COLS} FROM employees WHERE restaurant_id = $1 AND lower(staff_id) = lower($2) FOR UPDATE`, [
        r.id,
        input.staffId,
      ])
    ).rows[0];
    if (emp?.pin_locked_until && emp.pin_locked_until > now) {
      throw new AttendanceRejected('pin_locked', 'Too many incorrect PIN attempts. Please ask a manager.');
    }
    const ok = await verifySecret(input.pin, emp?.pin_hash);
    if (!emp || !ok) {
      if (emp) {
        await tx.query(
          `UPDATE employees SET pin_failed = pin_failed + 1,
                  pin_locked_until = CASE WHEN pin_failed + 1 >= 5 THEN now() + interval '15 minutes' ELSE pin_locked_until END
            WHERE id = $1`,
          [emp.id],
        );
      }
      // Rejections are committed by the route (see runAttendance) so this counter persists.
      throw new AttendanceRejected('invalid_pin', 'Staff ID or PIN is incorrect.');
    }
    if (emp.pin_failed > 0) await tx.query('UPDATE employees SET pin_failed = 0, pin_locked_until = NULL WHERE id = $1', [emp.id]);
    employeeId = emp.id;
    flags.push('pin_fallback');
  } else {
    source = 'manual';
    if (!input.claimedEmployeeId) throw new AttendanceRejected('invalid_request', 'Employee is required.');
    employeeId = input.claimedEmployeeId;
    flags.push('manual_entry');
  }

  // 3. Serialize everything for this employee (concurrent kiosks, double taps).
  const emp = (await tx.query<EmployeeRow>(`SELECT ${EMPLOYEE_COLS} FROM employees WHERE id = $1 AND restaurant_id = $2 FOR UPDATE`, [employeeId, r.id])).rows[0];
  if (!emp) throw new AttendanceRejected('employee_not_found', 'Employee not found.');
  if (emp.status !== 'active') throw new AttendanceRejected('employee_inactive', 'This employee is not active. Please contact a manager.');

  // Re-check idempotency after acquiring the lock (a concurrent retry may have just won).
  const raced = await tx.query('SELECT 1 FROM attendance_events WHERE id = $1', [input.eventId]);
  if (raced.rowCount) return recordAttendance(tx, r, templates, input);

  // 4. Decide the authoritative event time.
  let eventTime: Date;
  let reviewNeeded = false;
  const skewMs = settings.max_clock_skew_minutes * 60_000;
  if (source === 'manual') {
    eventTime = input.manualTime ?? now;
    if (eventTime.getTime() > now.getTime() + skewMs) throw new AttendanceRejected('invalid_request', 'Manual attendance cannot be in the future.');
  } else if (input.offline) {
    if (!input.deviceTimestamp) throw new AttendanceRejected('invalid_request', 'Offline events require the device timestamp.');
    flags.push('offline');
    eventTime = input.deviceTimestamp;
    if (eventTime.getTime() > now.getTime() + skewMs) {
      flags.push('clock_skew');
      reviewNeeded = true;
      eventTime = now;
    } else if (now.getTime() - eventTime.getTime() > settings.max_offline_age_hours * 3_600_000) {
      flags.push('stale_offline');
      reviewNeeded = true;
    }
  } else {
    eventTime = now; // server-confirmed time for online events
    if (input.deviceTimestamp && Math.abs(input.deviceTimestamp.getTime() - now.getTime()) > skewMs) flags.push('device_clock_skew');
  }

  // 5. Current state.
  let open: SessionRow | null = (await tx.query<SessionRow>(`SELECT ${SESSION_COLS} FROM attendance_sessions WHERE employee_id = $1 AND status = 'open'`, [emp.id])).rows[0] ?? null;
  if (open && eventTime.getTime() - open.check_in_at.getTime() > settings.max_session_hours * 3_600_000) {
    await flagMissingCheckout(tx, r, open, emp, 'exceeded_max_session_hours');
    open = null;
  }

  const branchId = input.branchId ?? emp.branch_id;
  const baseFlagsForNotify = [...flags];
  let session: SessionRow | null = null;
  let verification: 'verified' | 'pending_review' = 'verified';

  if (input.action === 'check_in') {
    if (open) {
      if (!input.offline) {
        throw new AttendanceRejected('already_checked_in', `You are already checked in since ${formatTime(open.check_in_at, r.timezone)}.`, {
          check_in_at: open.check_in_at.toISOString(),
        });
      }
      // An offline check-in arriving after another device already opened a session: keep
      // the fact, but do not let it alter the record without a human decision.
      flags.push('offline_conflict');
      reviewNeeded = true;
    } else {
      const assignments = await loadAssignments(tx, emp.id);
      const claimed = new Set(
        (
          await tx.query<{ shift_id: string; scheduled_start: Date }>(
            `SELECT shift_id, scheduled_start FROM attendance_sessions
              WHERE employee_id = $1 AND shift_id IS NOT NULL AND status <> 'voided' AND check_in_at > $2::timestamptz - interval '2 days'`,
            [emp.id, eventTime],
          )
        ).rows.map((x) => claimKey(x.shift_id, x.scheduled_start)),
      );
      const occ = resolveShiftForCheckIn(eventTime, assignments, r.timezone, settings.early_check_in_window_minutes, claimed);
      const late = computeLateness(eventTime, occ);
      if (late.isLate) flags.push('late');
      session = (
        await tx.query<SessionRow>(
          `INSERT INTO attendance_sessions (restaurant_id, branch_id, employee_id, status, check_in_event_id, check_in_at,
                  shift_id, scheduled_start, scheduled_end, late_minutes, is_late, needs_review)
           VALUES ($1,$2,$3,'open',$4,$5,$6,$7,$8,$9,$10,$11) RETURNING ${SESSION_COLS}`,
          [r.id, branchId, emp.id, input.eventId, eventTime, occ?.shift.id ?? null, occ?.start ?? null, occ?.end ?? null, late.lateMinutes, late.isLate, reviewNeeded],
        )
      ).rows[0];
    }
  } else {
    if (!open) {
      if (!input.offline) {
        throw new AttendanceRejected('no_active_session', 'You are not checked in, so there is nothing to check out from. Please CHECK IN first or ask a manager.');
      }
      flags.push('offline_conflict');
      reviewNeeded = true;
    } else if (eventTime.getTime() <= open.check_in_at.getTime()) {
      flags.push('checkout_before_checkin');
      reviewNeeded = true;
    } else {
      const minutesSince = (eventTime.getTime() - open.check_in_at.getTime()) / 60_000;
      if (!input.offline && source !== 'manual' && minutesSince < settings.min_minutes_between_in_and_out) {
        throw new AttendanceRejected('too_soon', 'You just checked in. CHECK OUT is available after a minute.', {
          check_in_at: open.check_in_at.toISOString(),
        });
      }
      const shift = await loadShift(tx, open.shift_id);
      const d = computeDuration(
        open.check_in_at,
        eventTime,
        shift,
        open.scheduled_start && open.scheduled_end ? { start: open.scheduled_start, end: open.scheduled_end } : null,
        settings,
      );
      if (d.overtimeMinutes > 0) flags.push('overtime');
      await tx.query(
        `UPDATE attendance_exceptions SET status = 'resolved', resolved_at = now(), resolution_note = 'Employee checked out later'
          WHERE session_id = $1 AND kind = 'missing_checkout' AND status = 'open'`,
        [open.id],
      );
      session = (
        await tx.query<SessionRow>(
          `UPDATE attendance_sessions SET status = 'closed', check_out_event_id = $2, check_out_at = $3, break_minutes = $4,
                  worked_minutes = $5, overtime_minutes = $6, needs_review = needs_review OR $7, updated_at = now()
            WHERE id = $1 RETURNING ${SESSION_COLS}`,
          [open.id, input.eventId, eventTime, d.breakMinutes, d.workedMinutes, d.overtimeMinutes, reviewNeeded],
        )
      ).rows[0];
    }
  }

  if (reviewNeeded) verification = 'pending_review';

  const evRow = (
    await tx.query(
      `INSERT INTO attendance_events (id, restaurant_id, branch_id, employee_id, event_type, event_time, device_timestamp,
              device_id, source, verification_status, recorded_offline, match_score, liveness_passed, session_id,
              exception_flags, note, created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       RETURNING id, event_type, event_time, verification_status, recorded_offline, exception_flags, server_received_at`,
      [
        input.eventId, r.id, branchId, emp.id, input.action, eventTime, input.deviceTimestamp ?? null, input.deviceId, source,
        verification, input.offline, matchScore, input.livenessPassed ?? null, session?.id ?? null, flags, input.note ?? null,
        input.actor.type === 'user' ? input.actor.id : null,
      ],
    )
  ).rows[0];

  await audit(tx, r.id, input.actor, `attendance.${input.action}`, { type: 'attendance_event', id: input.eventId }, {
    employee_id: emp.id, source, verification, flags, match_score: matchScore,
  });

  // 6. Payroll: every completed session gets a payout the manager settles (cash / QR / pending).
  let payout: PayoutRow | null = null;
  if (input.action === 'check_out' && session?.check_out_at) payout = await syncPayoutForSession(tx, r, session.id);

  // 7. Exceptions + notifications (outbox; delivered asynchronously).
  const bname = await branchName(tx, branchId);
  const link = `${r.publicBaseUrl}/#/attendance?event=${input.eventId}`;
  const typeLabel = input.action === 'check_in' ? 'Check-in' : 'Check-out';

  if (reviewNeeded) {
    const kind = flags.includes('clock_skew') ? 'clock_skew' : 'offline_conflict';
    await raiseException(tx, r.id, {
      kind, severity: 'warning', dedupeKey: `${kind}:${input.eventId}`, employeeId: emp.id, sessionId: session?.id, eventId: input.eventId,
      deviceId: input.deviceId, details: { flags, device_timestamp: input.deviceTimestamp?.toISOString() ?? null },
    });
    await enqueueNotification(tx, r.id, r.timezone, 'suspicious_event', `review:${input.eventId}`, (ns) =>
      renderEmail({
        restaurantName: r.name,
        heading: `Attendance needs review: ${emp.full_name}`,
        intro: 'An attendance event conflicts with existing records (for example, it was captured offline). It has been saved but not confirmed.',
        rows: [...eventEmailRows(ns, { employeeName: emp.full_name, staffId: emp.staff_id, type: typeLabel, at: eventTime, tz: r.timezone, branch: bname, status: 'Awaiting review' }), ['Flags', flags.join(', ')]],
        link: { href: link, label: 'Review in dashboard' },
      }),
    );
  } else if (input.action === 'check_in' && session?.is_late) {
    await raiseException(tx, r.id, {
      kind: 'late_arrival', severity: 'info', dedupeKey: `late:${session.id}`, employeeId: emp.id, sessionId: session.id, eventId: input.eventId,
      details: { late_minutes: session.late_minutes, scheduled_start: session.scheduled_start?.toISOString() },
    });
  }
  if (session && session.overtime_minutes > 0 && input.action === 'check_out') {
    await raiseException(tx, r.id, {
      kind: 'overtime', severity: 'info', dedupeKey: `overtime:${session.id}`, employeeId: emp.id, sessionId: session.id, eventId: input.eventId,
      details: { overtime_minutes: session.overtime_minutes },
    });
  }

  if (!reviewNeeded) {
    const statusText =
      input.action === 'check_in'
        ? session?.is_late ? `Late by ${session.late_minutes} min` : session?.scheduled_start ? 'On time' : 'Unscheduled'
        : session?.worked_minutes != null ? `Worked ${formatDuration(session.worked_minutes)}` : 'Checked out';
    const lateEmail = input.action === 'check_in' && session?.is_late;
    const notifyKind = lateEmail ? 'late_arrival' : input.action;
    const build = (ns: Parameters<typeof eventEmailRows>[0]) =>
      renderEmail({
        restaurantName: r.name,
        heading: `${lateEmail ? 'Late arrival' : typeLabel}: ${emp.full_name}`,
        rows: [
          ...eventEmailRows(ns, { employeeName: emp.full_name, staffId: emp.staff_id, type: typeLabel, at: eventTime, tz: r.timezone, branch: bname, status: statusText }),
          ...(session?.scheduled_start && input.action === 'check_in' ? [['Scheduled start', formatTime(session.scheduled_start, r.timezone)] as [string, string]] : []),
          ...(baseFlagsForNotify.includes('offline') ? [['Note', 'Captured while the kiosk was offline; synced later.'] as [string, string]] : []),
          ...(payout && payout.status === 'pending'
            ? [['Pay due', payout.rate_missing ? 'Salary not set yet' : `${formatMoney(payout.total_cents, r.settings.currency)}${payout.ot_minutes > 0 ? ` (incl. ${formatDuration(payout.ot_minutes)} OT)` : ''}`] as [string, string]]
            : []),
        ],
        link: { href: link, label: 'Open in dashboard' },
      });
    const res = await enqueueNotification(tx, r.id, r.timezone, notifyKind, `event:${input.eventId}`, build);
    // Late-arrival alerts disabled but check-in alerts enabled: still send the check-in email.
    if (lateEmail && res === 'disabled') await enqueueNotification(tx, r.id, r.timezone, 'check_in', `event:${input.eventId}`, build);
  }

  return buildResult(r, verification === 'pending_review' ? 'pending_review' : 'recorded', evRow, emp, session);
}

/** Records a recognition failure for owner follow-up. Contains no image or template. */
export async function reportUnknownFace(
  tx: Tx,
  r: RestaurantCtx,
  device: { id: string; name: string; branchId: string | null },
  info: { action: Action; bestScore: number | null; at: Date },
): Promise<void> {
  const bucket = Math.floor(info.at.getTime() / (10 * 60_000));
  const key = `unknown_face:${device.id}:${bucket}`;
  const created = await raiseException(tx, r.id, {
    kind: 'unknown_face', severity: 'info', dedupeKey: key, deviceId: device.id,
    details: { action: info.action, best_score: info.bestScore, at: info.at.toISOString() },
  });
  await audit(tx, r.id, { type: 'device', id: device.id }, 'recognition.unknown_face', { type: 'device', id: device.id }, { action: info.action, best_score: info.bestScore });
  if (created) {
    const bname = await branchName(tx, device.branchId);
    await enqueueNotification(tx, r.id, r.timezone, 'unknown_face', key, () =>
      renderEmail({
        restaurantName: r.name,
        heading: 'Unrecognised face at attendance kiosk',
        intro: 'Someone tried to use the kiosk but was not recognised. If this is a new employee, enrol them from the kiosk in Manager mode. No photo is stored or attached.',
        rows: [
          ['Kiosk', device.name],
          ...(bname ? [['Branch', bname] as [string, string]] : []),
          ['Requested action', info.action === 'check_in' ? 'Check-in' : 'Check-out'],
          ['Date', formatDate(info.at, r.timezone)],
          ['Time', formatTime(info.at, r.timezone)],
        ],
        link: { href: `${r.publicBaseUrl}/#/alerts`, label: 'Open alerts' },
      }),
    );
  }
}
