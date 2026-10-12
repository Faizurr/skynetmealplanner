import { addDays, isoWeekdayOf, localDate, timeToMinutes, zonedToUtc } from './time.js';
import type { RestaurantSettings } from './settings.js';

export interface ShiftDef {
  id: string;
  name: string;
  start_time: string; // HH:MM[:SS] local
  end_time: string;
  days_of_week: number[]; // ISO weekdays the shift STARTS on
  grace_minutes: number;
  unpaid_break_minutes: number;
  break_applies_after_minutes: number;
  overtime_after_minutes: number | null;
}

export interface AssignmentDef {
  shift: ShiftDef;
  effective_from: string; // YYYY-MM-DD
  effective_to: string | null;
}

export interface ShiftOccurrence {
  shift: ShiftDef;
  start: Date;
  end: Date;
  localDate: string; // the local date the shift starts on
}

/** All concrete shift occurrences that start on the given local dates. */
export function occurrencesFor(assignments: AssignmentDef[], dates: string[], tz: string): ShiftOccurrence[] {
  const out: ShiftOccurrence[] = [];
  for (const d of dates) {
    const wd = isoWeekdayOf(d);
    for (const a of assignments) {
      if (d < a.effective_from || (a.effective_to && d > a.effective_to)) continue;
      if (!a.shift.days_of_week.includes(wd)) continue;
      const crossesMidnight = timeToMinutes(a.shift.end_time) <= timeToMinutes(a.shift.start_time);
      const start = zonedToUtc(d, a.shift.start_time, tz);
      const end = zonedToUtc(crossesMidnight ? addDays(d, 1) : d, a.shift.end_time, tz);
      out.push({ shift: a.shift, start, end, localDate: d });
    }
  }
  return out.sort((x, y) => x.start.getTime() - y.start.getTime());
}

/**
 * Picks the scheduled shift a check-in belongs to: the occurrence whose window
 * [start - earlyWindow, end) contains the check-in, nearest to its start. Occurrences
 * already claimed by an earlier session (multiple shifts per day) are skipped.
 */
export function resolveShiftForCheckIn(
  at: Date,
  assignments: AssignmentDef[],
  tz: string,
  earlyWindowMinutes: number,
  claimedStarts: Set<string> = new Set(),
): ShiftOccurrence | null {
  const today = localDate(at, tz);
  const occ = occurrencesFor(assignments, [addDays(today, -1), today, addDays(today, 1)], tz);
  let best: ShiftOccurrence | null = null;
  for (const o of occ) {
    const key = `${o.shift.id}@${o.start.toISOString()}`;
    if (claimedStarts.has(key)) continue;
    const windowStart = o.start.getTime() - earlyWindowMinutes * 60_000;
    if (at.getTime() < windowStart || at.getTime() >= o.end.getTime()) continue;
    if (!best || Math.abs(at.getTime() - o.start.getTime()) < Math.abs(at.getTime() - best.start.getTime())) best = o;
  }
  return best;
}

export function claimKey(shiftId: string, start: Date): string {
  return `${shiftId}@${start.toISOString()}`;
}

export interface Lateness {
  lateMinutes: number;
  isLate: boolean;
}

export function computeLateness(checkIn: Date, occ: ShiftOccurrence | null): Lateness {
  if (!occ) return { lateMinutes: 0, isLate: false };
  const late = Math.max(0, Math.floor((checkIn.getTime() - occ.start.getTime()) / 60_000));
  return { lateMinutes: late, isLate: late > occ.shift.grace_minutes };
}

export interface DurationResult {
  rawMinutes: number;
  breakMinutes: number;
  workedMinutes: number;
  overtimeMinutes: number;
}

/**
 * Recorded working time = (out - in) - unpaid break (if the raw span reaches the break
 * threshold). Overtime is time beyond the shift's paid length (or the configured
 * overtime threshold).
 */
export function computeDuration(
  checkIn: Date,
  checkOut: Date,
  shift: ShiftDef | null,
  scheduled: { start: Date; end: Date } | null,
  settings: Pick<
    RestaurantSettings,
    'default_unpaid_break_minutes' | 'default_break_applies_after_minutes' | 'default_overtime_after_minutes'
  >,
): DurationResult {
  const rawMinutes = Math.max(0, Math.floor((checkOut.getTime() - checkIn.getTime()) / 60_000));
  const breakLen = shift ? shift.unpaid_break_minutes : settings.default_unpaid_break_minutes;
  const breakAfter = shift ? shift.break_applies_after_minutes : settings.default_break_applies_after_minutes;
  const breakMinutes = breakLen > 0 && rawMinutes >= breakAfter ? Math.min(breakLen, rawMinutes) : 0;
  const workedMinutes = rawMinutes - breakMinutes;

  let overtimeThreshold: number;
  if (shift && shift.overtime_after_minutes != null) overtimeThreshold = shift.overtime_after_minutes;
  else if (shift && scheduled) {
    const scheduledRaw = Math.round((scheduled.end.getTime() - scheduled.start.getTime()) / 60_000);
    const scheduledBreak = shift.unpaid_break_minutes > 0 && scheduledRaw >= shift.break_applies_after_minutes ? shift.unpaid_break_minutes : 0;
    overtimeThreshold = scheduledRaw - scheduledBreak;
  } else overtimeThreshold = settings.default_overtime_after_minutes;

  return { rawMinutes, breakMinutes, workedMinutes, overtimeMinutes: Math.max(0, workedMinutes - overtimeThreshold) };
}
