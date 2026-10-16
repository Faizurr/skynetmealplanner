import type { Tx } from './db.js';
import type { RestaurantCtx } from './attendance.js';
import { localDate, localDayRange } from './time.js';

/**
 * Staff leaderboard. Transparent, deterministic points so staff can see how to climb:
 *   +10 per on-time arrival for a scheduled shift
 *   +5  per day worked
 *   −5  per late arrival
 *   −10 per missing check-out
 * Total is floored at 0. Ties share a rank (1, 2, 2, 4). Streak = consecutive most-recent worked
 * sessions with no late arrival and no missing check-out.
 */
export const POINTS = { onTime: 10, dayWorked: 5, late: -5, missingCheckout: -10 } as const;

export interface LeaderRow {
  rank: number;
  employee_id: string;
  full_name: string;
  preferred_name: string | null;
  staff_id: string;
  has_photo: boolean;
  points: number;
  days_worked: number;
  on_time: number;
  late: number;
  missing_checkouts: number;
  worked_minutes: number;
  punctuality_rate: number | null;
  streak: number;
}

interface S {
  employee_id: string;
  status: string;
  eff_in: Date;
  scheduled_start: Date | null;
  scheduled_end: Date | null;
  is_late: boolean;
  worked_minutes: number | null;
}

export function scoreSessions(sessions: S[], tz: string, now = new Date()) {
  const days = new Set(sessions.map((s) => localDate(s.eff_in, tz)));
  let onTime = 0;
  let late = 0;
  let missing = 0;
  let worked = 0;
  let scheduled = 0;
  const isMissing = (s: S) => s.status === 'missing_checkout' || (s.status === 'open' && !!s.scheduled_end && s.scheduled_end < now);
  for (const s of sessions) {
    if (s.scheduled_start) {
      scheduled++;
      if (s.is_late) late++;
      else onTime++;
    }
    if (isMissing(s)) missing++;
    worked += s.worked_minutes ?? 0;
  }
  let streak = 0;
  for (const s of [...sessions].sort((a, b) => b.eff_in.getTime() - a.eff_in.getTime())) {
    if (s.is_late || isMissing(s)) break;
    streak++;
  }
  const raw = POINTS.onTime * onTime + POINTS.dayWorked * days.size + POINTS.late * late + POINTS.missingCheckout * missing;
  return {
    points: Math.max(0, raw),
    days_worked: days.size,
    on_time: onTime,
    late,
    missing_checkouts: missing,
    worked_minutes: worked,
    punctuality_rate: scheduled ? Math.round((onTime / scheduled) * 1000) / 10 : null,
    streak,
  };
}

export function rankRows<T extends { points: number; worked_minutes: number; full_name: string }>(rows: T[]): (T & { rank: number })[] {
  const sorted = [...rows].sort((a, b) => b.points - a.points || b.worked_minutes - a.worked_minutes || a.full_name.localeCompare(b.full_name));
  let rank = 0;
  let prev: T | null = null;
  return sorted.map((r, i) => {
    if (!prev || prev.points !== r.points || prev.worked_minutes !== r.worked_minutes) rank = i + 1;
    prev = r;
    return { ...r, rank };
  });
}

export async function leaderboard(tx: Tx, r: RestaurantCtx, from: string, to: string, branchId: string | null) {
  const start = localDayRange(from, r.timezone).start;
  const end = localDayRange(to, r.timezone).end;
  const emps = (
    await tx.query<{ id: string; full_name: string; preferred_name: string | null; staff_id: string; has_photo: boolean }>(
      `SELECT e.id, e.full_name, e.preferred_name, e.staff_id, EXISTS (SELECT 1 FROM employee_photos p WHERE p.employee_id = e.id) AS has_photo
         FROM employees e WHERE e.restaurant_id = $1 AND e.status = 'active' AND ($2::uuid IS NULL OR e.branch_id = $2)`,
      [r.id, branchId],
    )
  ).rows;
  const sessions = (
    await tx.query<S>(
      `SELECT employee_id, status, COALESCE(corrected_check_in_at, check_in_at) AS eff_in, scheduled_start, scheduled_end, is_late, worked_minutes
         FROM attendance_sessions
        WHERE restaurant_id = $1 AND status <> 'voided'
          AND COALESCE(corrected_check_in_at, check_in_at) >= $2 AND COALESCE(corrected_check_in_at, check_in_at) < $3`,
      [r.id, start, end],
    )
  ).rows;
  const byEmp = new Map<string, S[]>();
  for (const s of sessions) byEmp.set(s.employee_id, [...(byEmp.get(s.employee_id) ?? []), s]);

  const rows = rankRows(
    emps
      .filter((e) => byEmp.has(e.id))
      .map((e) => ({ employee_id: e.id, full_name: e.full_name, preferred_name: e.preferred_name, staff_id: e.staff_id, has_photo: e.has_photo, ...scoreSessions(byEmp.get(e.id)!, r.timezone) })),
  );

  // Awards only when the data supports them.
  const awards: { id: string; title: string; employee_id: string; detail: string }[] = [];
  const punctual = rows.filter((x) => x.on_time + x.late >= 3 && x.punctuality_rate != null).sort((a, b) => b.punctuality_rate! - a.punctuality_rate! || b.on_time - a.on_time)[0];
  if (punctual) awards.push({ id: 'punctual', title: 'Most punctual', employee_id: punctual.employee_id, detail: `${punctual.punctuality_rate}% on time` });
  const hours = [...rows].sort((a, b) => b.worked_minutes - a.worked_minutes)[0];
  if (hours && hours.worked_minutes > 0) awards.push({ id: 'hours', title: 'Most hours', employee_id: hours.employee_id, detail: `${Math.round(hours.worked_minutes / 6) / 10} h` });
  const streak = [...rows].sort((a, b) => b.streak - a.streak)[0];
  if (streak && streak.streak >= 3) awards.push({ id: 'streak', title: 'Longest streak', employee_id: streak.employee_id, detail: `${streak.streak} in a row` });

  return { from, to, timezone: r.timezone, restaurant: r.name, points: POINTS, rows: rows as LeaderRow[], awards };
}
