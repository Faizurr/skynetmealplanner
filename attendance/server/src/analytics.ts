import type { Tx } from './db.js';
import type { RestaurantCtx } from './attendance.js';
import { occurrencesFor, claimKey, type AssignmentDef, type ShiftDef } from './shifts.js';
import { addDays, localDate, localDayRange, toLocalParts, formatTime } from './time.js';

/**
 * Metric definitions (deterministic; documented in docs/ANALYTICS.md):
 *  - Scheduled occurrence: a shift assignment that starts on a local date.
 *  - Attended: a non-voided session linked to that occurrence (same shift + scheduled start).
 *  - Absence: a scheduled occurrence that has ENDED with no linked session.
 *  - Late: session.is_late (check-in later than scheduled start + grace).
 *  - Punctuality rate: on-time attended occurrences / attended occurrences.
 *  - Missing checkout: session with status missing_checkout, or open past its scheduled end.
 *  - Worked minutes: from closed sessions (corrected values when a correction was approved).
 *  - Consistency: attended / (attended + absences) per employee.
 * Unscheduled sessions count toward hours but not toward punctuality or absence.
 */

interface SessionLite {
  id: string;
  employee_id: string;
  branch_id: string | null;
  status: string;
  check_in_at: Date;
  check_out_at: Date | null;
  effective_in: Date;
  effective_out: Date | null;
  shift_id: string | null;
  scheduled_start: Date | null;
  scheduled_end: Date | null;
  is_late: boolean;
  late_minutes: number;
  worked_minutes: number | null;
  overtime_minutes: number;
  break_minutes: number;
  needs_review: boolean;
  is_corrected: boolean;
}

interface EmployeeLite {
  id: string;
  full_name: string;
  staff_id: string;
  branch_id: string | null;
  status: string;
  job_title: string | null;
}

async function loadEmployees(tx: Tx, restaurantId: string, branchId?: string | null): Promise<EmployeeLite[]> {
  const r = await tx.query<EmployeeLite>(
    `SELECT id, full_name, staff_id, branch_id, status, job_title FROM employees
      WHERE restaurant_id = $1 AND status <> 'deactivated' AND ($2::uuid IS NULL OR branch_id = $2)
      ORDER BY full_name`,
    [restaurantId, branchId ?? null],
  );
  return r.rows;
}

async function loadAllAssignments(tx: Tx, restaurantId: string): Promise<Map<string, AssignmentDef[]>> {
  const r = await tx.query<ShiftDef & { employee_id: string; effective_from: string; effective_to: string | null }>(
    `SELECT a.employee_id, s.id, s.name, s.start_time::text, s.end_time::text, s.days_of_week, s.grace_minutes,
            s.unpaid_break_minutes, s.break_applies_after_minutes, s.overtime_after_minutes, a.effective_from, a.effective_to
       FROM shift_assignments a JOIN shifts s ON s.id = a.shift_id
      WHERE a.restaurant_id = $1 AND s.active`,
    [restaurantId],
  );
  const map = new Map<string, AssignmentDef[]>();
  for (const { employee_id, effective_from, effective_to, ...shift } of r.rows) {
    const list = map.get(employee_id) ?? [];
    list.push({ shift, effective_from, effective_to });
    map.set(employee_id, list);
  }
  return map;
}

async function loadSessions(tx: Tx, restaurantId: string, from: Date, to: Date, branchId?: string | null): Promise<SessionLite[]> {
  const r = await tx.query<SessionLite>(
    `SELECT id, employee_id, branch_id, status, check_in_at, check_out_at,
            COALESCE(corrected_check_in_at, check_in_at) AS effective_in,
            COALESCE(corrected_check_out_at, check_out_at) AS effective_out,
            shift_id, scheduled_start, scheduled_end, is_late, late_minutes, worked_minutes, overtime_minutes,
            break_minutes, needs_review, is_corrected
       FROM attendance_sessions
      WHERE restaurant_id = $1 AND status <> 'voided'
        AND ((COALESCE(corrected_check_in_at, check_in_at) >= $2 AND COALESCE(corrected_check_in_at, check_in_at) < $3)
             OR (scheduled_start >= $2 AND scheduled_start < $3))
        AND ($4::uuid IS NULL OR branch_id = $4)
      ORDER BY check_in_at`,
    [restaurantId, from, to, branchId ?? null],
  );
  return r.rows;
}

// ---------------------------------------------------------------------------
// Today overview
// ---------------------------------------------------------------------------
export async function overview(tx: Tx, r: RestaurantCtx, date: string, branchId: string | null, offlineMinutes: number) {
  const tz = r.timezone;
  const now = new Date();
  const { start, end } = localDayRange(date, tz);
  const employees = await loadEmployees(tx, r.id, branchId);
  const active = employees.filter((e) => e.status === 'active');
  const assignments = await loadAllAssignments(tx, r.id);
  // Include yesterday so overnight shifts that started before midnight and are still running count "today".
  const prevStart = localDayRange(addDays(date, -1), tz).start;
  const allSessions = await loadSessions(tx, r.id, prevStart, end, branchId);
  const sessions = allSessions.filter((s) => s.effective_in >= start || (s.scheduled_start != null && s.scheduled_start >= start));
  const openSessions = (
    await tx.query<SessionLite>(
      `SELECT id, employee_id, branch_id, status, check_in_at, check_out_at, check_in_at AS effective_in, NULL AS effective_out,
              shift_id, scheduled_start, scheduled_end, is_late, late_minutes, worked_minutes, overtime_minutes, break_minutes,
              needs_review, is_corrected
         FROM attendance_sessions WHERE restaurant_id = $1 AND status = 'open' AND ($2::uuid IS NULL OR branch_id = $2)`,
      [r.id, branchId],
    )
  ).rows;
  const empById = new Map(employees.map((e) => [e.id, e]));

  const sessionsByEmp = new Map<string, SessionLite[]>();
  for (const s of sessions) sessionsByEmp.set(s.employee_id, [...(sessionsByEmp.get(s.employee_id) ?? []), s]);
  const openByEmp = new Map(openSessions.map((s) => [s.employee_id, s]));

  type RosterStatus = 'working' | 'checked_out' | 'late_not_arrived' | 'not_yet_due' | 'absent' | 'unscheduled_working';
  const roster: {
    employee: EmployeeLite;
    status: RosterStatus;
    scheduled_start: string | null;
    scheduled_end: string | null;
    shift_name: string | null;
    check_in_at: string | null;
    check_out_at: string | null;
    is_late: boolean;
    late_minutes: number;
    worked_minutes: number | null;
  }[] = [];

  let expected = 0;
  let late = 0;
  for (const e of active) {
    // Shifts starting today, plus last night's overnight shift if it runs into today.
    const occ = occurrencesFor(assignments.get(e.id) ?? [], [addDays(date, -1), date], tz).filter(
      (o) => o.localDate === date || o.end.getTime() > start.getTime(),
    );
    const firstOcc = occ[0] ?? null;
    const linked = firstOcc
      ? allSessions.find((s) => s.employee_id === e.id && s.shift_id === firstOcc.shift.id && s.scheduled_start?.getTime() === firstOcc.start.getTime())
      : undefined;
    const empSessions = [...(sessionsByEmp.get(e.id) ?? [])];
    if (linked && !empSessions.includes(linked)) empSessions.unshift(linked);
    const open = openByEmp.get(e.id);
    if (occ.length) expected++;
    for (const s of empSessions) if (s.is_late) late++;
    const latest = open ?? empSessions[empSessions.length - 1];
    let status: RosterStatus | null = null;
    if (open) status = open.shift_id ? 'working' : 'unscheduled_working';
    else if (empSessions.length) status = 'checked_out';
    else if (firstOcc) {
      const graceEnd = firstOcc.start.getTime() + firstOcc.shift.grace_minutes * 60_000;
      status = now.getTime() >= firstOcc.end.getTime() ? 'absent' : now.getTime() > graceEnd ? 'late_not_arrived' : 'not_yet_due';
    }
    if (!status) continue; // not scheduled, not present: omit from today's roster
    roster.push({
      employee: e,
      status,
      scheduled_start: firstOcc?.start.toISOString() ?? null,
      scheduled_end: firstOcc?.end.toISOString() ?? null,
      shift_name: firstOcc?.shift.name ?? null,
      check_in_at: (linked ?? latest)?.effective_in.toISOString() ?? null,
      check_out_at: open ? null : (latest?.effective_out?.toISOString() ?? null),
      is_late: (linked ?? latest)?.is_late ?? false,
      late_minutes: (linked ?? latest)?.late_minutes ?? 0,
      worked_minutes: open ? null : (latest?.worked_minutes ?? null),
    });
  }

  const counts = (s: RosterStatus) => roster.filter((x) => x.status === s).length;
  const missingCheckouts = (
    await tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM attendance_sessions
        WHERE restaurant_id = $1 AND ($2::uuid IS NULL OR branch_id = $2)
          AND (status = 'missing_checkout' AND check_in_at >= $3::timestamptz - interval '7 days'
               OR (status = 'open' AND scheduled_end IS NOT NULL AND scheduled_end < now()))`,
      [r.id, branchId, start],
    )
  ).rows[0].n;
  const openExceptions = (
    await tx.query<{ kind: string; n: number }>(
      `SELECT kind, count(*)::int AS n FROM attendance_exceptions WHERE restaurant_id = $1 AND status = 'open' GROUP BY kind`,
      [r.id],
    )
  ).rows;
  const pendingReview = (
    await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM attendance_events WHERE restaurant_id = $1 AND verification_status = 'pending_review'`, [r.id])
  ).rows[0].n;
  const pendingCorrections = (
    await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM attendance_corrections WHERE restaurant_id = $1 AND status = 'requested'`, [r.id])
  ).rows[0].n;
  const pendingEnrollments = (
    await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM face_enrollments WHERE restaurant_id = $1 AND status = 'pending_confirmation'`, [r.id])
  ).rows[0].n;
  const devices = (
    await tx.query<{ id: string; name: string; status: string; last_seen_at: Date | null; pending_queue_count: number; app_version: string | null; last_error: string | null }>(
      `SELECT id, name, status, last_seen_at, pending_queue_count, app_version, last_error FROM devices
        WHERE restaurant_id = $1 AND status = 'active' ORDER BY name`,
      [r.id],
    )
  ).rows.map((d) => ({
    ...d,
    online: !!d.last_seen_at && now.getTime() - d.last_seen_at.getTime() < offlineMinutes * 60_000,
  }));

  return {
    date,
    timezone: tz,
    metrics: {
      expected_today: expected,
      currently_working: openSessions.filter((s) => empById.has(s.employee_id)).length,
      checked_out: counts('checked_out'),
      not_yet_arrived: counts('not_yet_due') + counts('late_not_arrived'),
      late_not_arrived: counts('late_not_arrived'),
      absent: counts('absent'),
      late_arrivals: late,
      missing_checkouts: missingCheckouts,
      pending_review: pendingReview,
      pending_corrections: pendingCorrections,
      pending_enrollments: pendingEnrollments,
      open_exceptions: openExceptions.reduce((a, x) => a + x.n, 0),
      devices_offline: devices.filter((d) => !d.online).length,
      devices_with_unsynced_events: devices.filter((d) => d.pending_queue_count > 0).length,
    },
    exceptions_by_kind: Object.fromEntries(openExceptions.map((x) => [x.kind, x.n])),
    roster: roster.sort((a, b) => order(a.status) - order(b.status) || a.employee.full_name.localeCompare(b.employee.full_name)),
    devices,
  };
}

function order(s: string): number {
  return ['late_not_arrived', 'working', 'unscheduled_working', 'not_yet_due', 'checked_out', 'absent'].indexOf(s);
}

// ---------------------------------------------------------------------------
// Range analytics + insights
// ---------------------------------------------------------------------------
export async function analytics(tx: Tx, r: RestaurantCtx, from: string, to: string, branchId: string | null) {
  const tz = r.timezone;
  const now = new Date();
  const dates: string[] = [];
  for (let d = from; d <= to && dates.length < 400; d = addDays(d, 1)) dates.push(d);
  const rangeStart = localDayRange(from, tz).start;
  const rangeEnd = localDayRange(to, tz).end;

  const employees = await loadEmployees(tx, r.id, branchId);
  const active = employees.filter((e) => e.status === 'active');
  const assignments = await loadAllAssignments(tx, r.id);
  const sessions = await loadSessions(tx, r.id, rangeStart, rangeEnd, branchId);
  const branches = (await tx.query<{ id: string; name: string }>('SELECT id, name FROM branches WHERE restaurant_id = $1', [r.id])).rows;
  const branchName = new Map(branches.map((b) => [b.id, b.name]));

  const linkedKeys = new Set(sessions.filter((s) => s.shift_id && s.scheduled_start).map((s) => `${s.employee_id}|${claimKey(s.shift_id!, s.scheduled_start!)}`));

  const daily = new Map(dates.map((d) => [d, { date: d, scheduled: 0, attended: 0, late: 0, absences: 0, worked_minutes: 0, sessions: 0, missing_checkouts: 0 }]));
  const perEmp = new Map(
    employees.map((e) => [e.id, { employee_id: e.id, full_name: e.full_name, staff_id: e.staff_id, scheduled: 0, attended: 0, late: 0, late_minutes_total: 0, absences: 0, worked_minutes: 0, overtime_minutes: 0, missing_checkouts: 0, sessions: 0 }]),
  );
  const absenceList: { employee_id: string; date: string; shift: string }[] = [];

  // Scheduled occurrences and absences.
  for (const e of active) {
    for (const o of occurrencesFor(assignments.get(e.id) ?? [], dates, tz)) {
      const day = daily.get(o.localDate)!;
      const pe = perEmp.get(e.id)!;
      day.scheduled++;
      pe.scheduled++;
      const key = `${e.id}|${claimKey(o.shift.id, o.start)}`;
      if (linkedKeys.has(key)) continue;
      if (o.end.getTime() <= now.getTime()) {
        day.absences++;
        pe.absences++;
        absenceList.push({ employee_id: e.id, date: o.localDate, shift: o.shift.name });
      }
    }
  }

  const arrivalByHour = Array.from({ length: 24 }, (_, h) => ({ hour: h, check_ins: 0, late: 0 }));
  const byWeekday = Array.from({ length: 7 }, (_, i) => ({ weekday: i + 1, sessions: 0, late: 0, scheduled_sessions: 0, missing_checkouts: 0, absences: 0 }));
  for (const a of absenceList) byWeekday[(new Date(a.date + 'T12:00:00Z').getUTCDay() + 6) % 7].absences++;
  const byBranch = new Map<string, { branch_id: string | null; name: string; sessions: 0 | number; late: number; scheduled_sessions: number; worked_minutes: number; missing_checkouts: number }>();
  const byShift = new Map<string, { shift_id: string; sessions: number; late: number; missing_checkouts: number }>();

  let scheduledSessions = 0;
  let onTime = 0;
  let lateCount = 0;
  let lateMinutesTotal = 0;
  let closedCount = 0;
  let workedTotal = 0;
  let overtimeTotal = 0;
  let missingCheckouts = 0;

  for (const s of sessions) {
    const d = localDate(s.effective_in, tz);
    const day = daily.get(d);
    const pe = perEmp.get(s.employee_id);
    const lp = toLocalParts(s.effective_in, tz);
    const missing = s.status === 'missing_checkout' || (s.status === 'open' && !!s.scheduled_end && s.scheduled_end < now);
    arrivalByHour[lp.hour].check_ins++;
    const wd = byWeekday[lp.isoWeekday - 1];
    wd.sessions++;
    const bkey = s.branch_id ?? 'none';
    const b = byBranch.get(bkey) ?? { branch_id: s.branch_id, name: s.branch_id ? branchName.get(s.branch_id) ?? 'Unknown' : 'Unassigned', sessions: 0, late: 0, scheduled_sessions: 0, worked_minutes: 0, missing_checkouts: 0 };
    b.sessions++;
    if (day) day.sessions++;
    if (pe) pe.sessions++;
    if (s.shift_id && s.scheduled_start) {
      scheduledSessions++;
      wd.scheduled_sessions++;
      b.scheduled_sessions++;
      const sh = byShift.get(s.shift_id) ?? { shift_id: s.shift_id, sessions: 0, late: 0, missing_checkouts: 0 };
      sh.sessions++;
      if (s.is_late) sh.late++;
      if (missing) sh.missing_checkouts++;
      byShift.set(s.shift_id, sh);
      const sd = daily.get(localDate(s.scheduled_start, tz));
      if (sd) sd.attended++;
      if (pe) pe.attended++;
      if (s.is_late) {
        lateCount++;
        lateMinutesTotal += s.late_minutes;
        wd.late++;
        b.late++;
        arrivalByHour[lp.hour].late++;
        if (day) day.late++;
        if (pe) {
          pe.late++;
          pe.late_minutes_total += s.late_minutes;
        }
      } else onTime++;
    }
    if (s.worked_minutes != null && s.effective_out) {
      closedCount++;
      workedTotal += s.worked_minutes;
      overtimeTotal += s.overtime_minutes;
      b.worked_minutes += s.worked_minutes;
      if (day) day.worked_minutes += s.worked_minutes;
      if (pe) {
        pe.worked_minutes += s.worked_minutes;
        pe.overtime_minutes += s.overtime_minutes;
      }
    }
    if (missing) {
      missingCheckouts++;
      wd.missing_checkouts++;
      b.missing_checkouts++;
      if (day) day.missing_checkouts++;
      if (pe) pe.missing_checkouts++;
    }
    byBranch.set(bkey, b);
  }

  const totalAbsences = absenceList.length;
  const totalScheduled = [...daily.values()].reduce((a, d) => a + d.scheduled, 0);
  const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);

  const summary = {
    scheduled_shifts: totalScheduled,
    attended_scheduled_shifts: scheduledSessions,
    total_sessions: sessions.length,
    punctuality_rate: pct(onTime, scheduledSessions),
    late_arrivals: lateCount,
    late_frequency: pct(lateCount, scheduledSessions),
    average_lateness_minutes: lateCount ? Math.round(lateMinutesTotal / lateCount) : null,
    absences: totalAbsences,
    attendance_rate: pct(scheduledSessions, scheduledSessions + totalAbsences),
    missing_checkouts: missingCheckouts,
    average_worked_minutes: closedCount ? Math.round(workedTotal / closedCount) : null,
    total_worked_minutes: workedTotal,
    total_overtime_minutes: overtimeTotal,
  };

  const shiftNames = new Map<string, string>();
  for (const list of assignments.values()) for (const a of list) shiftNames.set(a.shift.id, a.shift.name);
  const empName = new Map(employees.map((e) => [e.id, e.full_name]));

  // ---- Insights: only emitted when supported by data, always with the supporting numbers.
  const insights: { id: string; severity: 'info' | 'warning'; title: string; detail: string; employee_ids?: string[] }[] = [];

  // (a) Repeated significant lateness over each employee's last 7 scheduled sessions.
  const byEmpSched = new Map<string, SessionLite[]>();
  for (const s of sessions) if (s.shift_id && s.scheduled_start) byEmpSched.set(s.employee_id, [...(byEmpSched.get(s.employee_id) ?? []), s]);
  const chronicLate: string[] = [];
  for (const [eid, list] of byEmpSched) {
    const last7 = list.slice(-7);
    const bigLate = last7.filter((s) => s.late_minutes > 15).length;
    if (last7.length >= 4 && bigLate >= 3) chronicLate.push(eid);
  }
  if (chronicLate.length) {
    insights.push({
      id: 'repeated_lateness',
      severity: 'warning',
      title: `${chronicLate.length} employee${chronicLate.length > 1 ? 's' : ''} arrived more than 15 minutes late on 3 or more of their last 7 scheduled shifts`,
      detail: chronicLate.map((id) => empName.get(id)).join(', '),
      employee_ids: chronicLate,
    });
  }

  // (b) Shift with disproportionate missing checkouts.
  const shiftList = [...byShift.values()].filter((s) => s.sessions >= 3);
  const avgMissingRate = shiftList.length ? shiftList.reduce((a, s) => a + s.missing_checkouts / s.sessions, 0) / shiftList.length : 0;
  for (const s of shiftList) {
    const rate = s.missing_checkouts / s.sessions;
    if (s.missing_checkouts >= 2 && shiftList.length > 1 && rate >= 1.5 * avgMissingRate) {
      insights.push({
        id: `missing_checkout_shift_${s.shift_id}`,
        severity: 'warning',
        title: `The ${shiftNames.get(s.shift_id) ?? 'unnamed'} shift has more missing check-outs than other shifts`,
        detail: `${s.missing_checkouts} of ${s.sessions} sessions (${Math.round(rate * 100)}%) vs an average of ${Math.round(avgMissingRate * 100)}% across shifts.`,
      });
    }
  }

  // (c) Weekday with the worst punctuality (needs enough samples).
  const wdNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const wdEligible = byWeekday.filter((w) => w.scheduled_sessions >= 5);
  if (wdEligible.length >= 3 && scheduledSessions > 0) {
    const overallLate = lateCount / scheduledSessions;
    const worst = wdEligible.reduce((a, b) => (b.late / b.scheduled_sessions > a.late / a.scheduled_sessions ? b : a));
    const worstRate = worst.late / worst.scheduled_sessions;
    if (worst.late >= 3 && worstRate >= overallLate * 1.5) {
      insights.push({
        id: 'weekday_lateness',
        severity: 'info',
        title: `Late arrivals are most common on ${wdNames[worst.weekday - 1]}s`,
        detail: `${Math.round(worstRate * 100)}% of scheduled ${wdNames[worst.weekday - 1]} shifts started late vs ${Math.round(overallLate * 100)}% overall.`,
      });
    }
  }

  // (d) Records awaiting a decision.
  const pending = (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM attendance_events WHERE restaurant_id = $1 AND verification_status = 'pending_review'`, [r.id])).rows[0].n;
  const pendingCorr = (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM attendance_corrections WHERE restaurant_id = $1 AND status = 'requested'`, [r.id])).rows[0].n;
  if (pending + pendingCorr > 0) {
    insights.push({
      id: 'pending_review',
      severity: 'warning',
      title: `${pending + pendingCorr} attendance record${pending + pendingCorr > 1 ? 's need' : ' needs'} manager review`,
      detail: `${pending} event${pending === 1 ? '' : 's'} awaiting review, ${pendingCorr} correction request${pendingCorr === 1 ? '' : 's'}.`,
    });
  }

  // (e) Overtime concentration.
  if (overtimeTotal >= 120) {
    const top = [...perEmp.values()].sort((a, b) => b.overtime_minutes - a.overtime_minutes)[0];
    if (top && top.overtime_minutes / overtimeTotal >= 0.4) {
      insights.push({
        id: 'overtime_concentration',
        severity: 'info',
        title: `${top.full_name} accounts for ${Math.round((top.overtime_minutes / overtimeTotal) * 100)}% of recorded overtime`,
        detail: `${Math.round(top.overtime_minutes / 6) / 10}h of ${Math.round(overtimeTotal / 6) / 10}h overtime in this period.`,
        employee_ids: [top.employee_id],
      });
    }
  }

  // (f) Punctuality trend vs the previous period of equal length (enough samples on both sides).
  const len = dates.length;
  const prevFrom = addDays(from, -len);
  const prev = await loadSessions(tx, r.id, localDayRange(prevFrom, tz).start, rangeStart, branchId);
  const prevSched = prev.filter((s) => s.shift_id && s.scheduled_start);
  if (prevSched.length >= 10 && scheduledSessions >= 10) {
    const prevRate = prevSched.filter((s) => !s.is_late).length / prevSched.length;
    const curRate = onTime / scheduledSessions;
    const delta = Math.round((curRate - prevRate) * 1000) / 10;
    if (Math.abs(delta) >= 5) {
      insights.push({
        id: 'punctuality_trend',
        severity: delta < 0 ? 'warning' : 'info',
        title: `Punctuality ${delta < 0 ? 'fell' : 'improved'} ${Math.abs(delta)} points vs the previous ${len} days`,
        detail: `${Math.round(curRate * 1000) / 10}% on time now vs ${Math.round(prevRate * 1000) / 10}% before.`,
      });
    }
  }

  return {
    from,
    to,
    timezone: tz,
    summary,
    daily: [...daily.values()],
    by_weekday: byWeekday.map((w) => ({ ...w, name: wdNames[w.weekday - 1], late_rate: pct(w.late, w.scheduled_sessions) })),
    arrival_by_hour: arrivalByHour,
    by_branch: [...byBranch.values()].map((b) => ({ ...b, late_rate: pct(b.late, b.scheduled_sessions) })),
    by_shift: [...byShift.values()].map((s) => ({ ...s, name: shiftNames.get(s.shift_id) ?? 'Unknown', late_rate: pct(s.late, s.sessions) })),
    employees: [...perEmp.values()].map((p) => ({
      ...p,
      punctuality_rate: pct(p.attended - p.late, p.attended),
      consistency: pct(p.attended, p.attended + p.absences),
      average_lateness_minutes: p.late ? Math.round(p.late_minutes_total / p.late) : null,
    })),
    absences: absenceList,
    insights,
  };
}

export function dailySummaryRows(o: Awaited<ReturnType<typeof overview>>, tz: string): [string, string][] {
  const m = o.metrics;
  const rows: [string, string][] = [
    ['Date', o.date],
    ['Expected (scheduled)', String(m.expected_today)],
    ['Still checked in', String(m.currently_working)],
    ['Checked out', String(m.checked_out)],
    ['Late arrivals', String(m.late_arrivals)],
    ['Absent', String(m.absent)],
    ['Missing check-outs', String(m.missing_checkouts)],
    ['Awaiting review', String(m.pending_review + m.pending_corrections)],
  ];
  const lateNames = o.roster.filter((x) => x.is_late).map((x) => `${x.employee.full_name} (${x.late_minutes}m, in ${x.check_in_at ? formatTime(new Date(x.check_in_at), tz) : '—'})`);
  if (lateNames.length) rows.push(['Late', lateNames.join('; ')]);
  const absent = o.roster.filter((x) => x.status === 'absent').map((x) => x.employee.full_name);
  if (absent.length) rows.push(['Absent', absent.join(', ')]);
  return rows;
}
