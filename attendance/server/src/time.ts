/**
 * Minimal, dependency-free IANA time zone helpers built on Intl.
 * All persisted timestamps are UTC; these helpers convert for shift rules and display.
 */

export interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  isoWeekday: number; // 1=Mon … 7=Sun
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export function isValidTimeZone(tz: string): boolean {
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

export function toLocalParts(date: Date, tz: string): LocalParts {
  const parts: Record<string, string> = {};
  for (const p of formatter(tz).formatToParts(date)) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    isoWeekday: WEEKDAYS[parts.weekday],
  };
}

/** Offset (ms) of tz from UTC at the given instant. */
export function tzOffsetMs(date: Date, tz: string): number {
  const p = toLocalParts(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - (date.getTime() - date.getUTCMilliseconds());
}

/** Converts a wall-clock time in tz to a UTC instant. */
export function zonedToUtc(ymd: string, hhmm: string, tz: string): Date {
  const [y, m, d] = ymd.split('-').map(Number);
  const [hh, mm, ss = 0] = hhmm.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm, ss);
  let ts = guess - tzOffsetMs(new Date(guess), tz);
  // Second pass corrects for DST transitions between the guess and the result.
  const off2 = tzOffsetMs(new Date(ts), tz);
  ts = guess - off2;
  return new Date(ts);
}

export function localDate(date: Date, tz: string): string {
  const p = toLocalParts(date, tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

export function isoWeekdayOf(ymd: string): number {
  const [y, m, d] = ymd.split('-').map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return wd === 0 ? 7 : wd;
}

/** Start/end (UTC) of a local calendar day. */
export function localDayRange(ymd: string, tz: string): { start: Date; end: Date } {
  return { start: zonedToUtc(ymd, '00:00', tz), end: zonedToUtc(addDays(ymd, 1), '00:00', tz) };
}

export function formatLocal(date: Date, tz: string, opts: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat('en-MY', { timeZone: tz, ...opts }).format(date);
}

export function formatTime(date: Date, tz: string): string {
  return formatLocal(date, tz, { hour: 'numeric', minute: '2-digit', hour12: true });
}

export function formatDate(date: Date, tz: string): string {
  return formatLocal(date, tz, { day: 'numeric', month: 'long', year: 'numeric' });
}

export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

/** Minutes since local midnight for an HH:MM[:SS] string. */
export function timeToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/** True if local time t (minutes) lies within [start, end) — wrapping past midnight if needed. */
export function inLocalWindow(t: number, start: number, end: number): boolean {
  return start <= end ? t >= start && t < end : t >= start || t < end;
}
