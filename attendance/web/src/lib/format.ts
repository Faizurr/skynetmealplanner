/** Formatting helpers. All wall-clock output uses the restaurant timezone and en-MY conventions. */

export const LOCALE = 'en-MY';

const cache = new Map<string, Intl.DateTimeFormat>();
function dtf(tz: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = tz + JSON.stringify(opts);
  let f = cache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(LOCALE, { timeZone: tz, ...opts });
    cache.set(key, f);
  }
  return f;
}

type DateLike = string | number | Date | null | undefined;
function toDate(v: DateLike): Date | null {
  if (v === null || v === undefined || v === '') return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "9:02 am" */
export function fmtTime(v: DateLike, tz: string): string {
  const d = toDate(v);
  if (!d) return '—';
  return dtf(tz, { hour: 'numeric', minute: '2-digit', hour12: true }).format(d).replace(/\s+/g, ' ').toLowerCase();
}

/** "12 Oct 2026" */
export function fmtDate(v: DateLike, tz: string): string {
  const d = toDate(v);
  if (!d) return '—';
  return dtf(tz, { day: 'numeric', month: 'short', year: 'numeric' }).format(d);
}

/** "Mon, 12 Oct" */
export function fmtDayShort(v: DateLike, tz: string): string {
  const d = toDate(v);
  if (!d) return '—';
  return dtf(tz, { weekday: 'short', day: 'numeric', month: 'short' }).format(d);
}

/** "12 Oct 2026, 9:02 am" */
export function fmtDateTime(v: DateLike, tz: string): string {
  const d = toDate(v);
  if (!d) return '—';
  return `${fmtDate(d, tz)}, ${fmtTime(d, tz)}`;
}

/** Formats a local calendar date string (YYYY-MM-DD) without timezone drift: "12 Oct 2026". */
export function fmtYmd(ymd: string, opts: { weekday?: boolean; year?: boolean } = {}): string {
  const [y, m, d] = ymd.split('-').map(Number);
  if (!y || !m || !d) return ymd;
  const date = new Date(Date.UTC(y, m - 1, d, 12));
  return dtf('UTC', { day: 'numeric', month: 'short', ...(opts.year === false ? {} : { year: 'numeric' }), ...(opts.weekday ? { weekday: 'short' } : {}) }).format(date);
}

/** "8h 36m", "45m", "0m". Null → "—". */
export function fmtDuration(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || Number.isNaN(minutes)) return '—';
  const sign = minutes < 0 ? '-' : '';
  const m = Math.round(Math.abs(minutes));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h === 0) return `${sign}${r}m`;
  return `${sign}${h}h ${String(r).padStart(2, '0')}m`;
}

/** Hours with one decimal: "38.5h" */
export function fmtHours(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined) return '—';
  return `${(Math.round((minutes / 60) * 10) / 10).toLocaleString(LOCALE)}h`;
}

export function fmtPct(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  return `${Math.round(v * 10) / 10}%`;
}

export function fmtNumber(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  return v.toLocaleString(LOCALE);
}

/** "just now", "4 min ago", "3 h ago", "2 days ago". */
export function fmtRelative(v: DateLike, now: Date = new Date()): string {
  const d = toDate(v);
  if (!d) return 'never';
  const s = Math.round((now.getTime() - d.getTime()) / 1000);
  if (s < 0) {
    const f = -s;
    if (f < 60) return 'in a moment';
    if (f < 3600) return `in ${Math.round(f / 60)} min`;
    return `in ${Math.round(f / 3600)} h`;
  }
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const days = Math.round(s / 86400);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

/** Calendar parts of an instant in a timezone. */
export function zonedParts(v: Date, tz: string): { y: number; m: number; d: number; hh: number; mm: number; ss: number } {
  const parts = dtf(tz, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(v);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return { y: get('year'), m: get('month'), d: get('day'), hh: get('hour') % 24, mm: get('minute'), ss: get('second') };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Local calendar date (YYYY-MM-DD) of an instant in tz. */
export function localYmd(v: DateLike, tz: string): string {
  const d = toDate(v) ?? new Date();
  const p = zonedParts(d, tz);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

export function addDaysYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

export function daysBetween(fromYmd: string, toYmd: string): number {
  return Math.round((Date.parse(`${toYmd}T00:00:00Z`) - Date.parse(`${fromYmd}T00:00:00Z`)) / 86400000);
}

/** Converts a wall-clock time in tz ("2026-10-12", "09:05") to an ISO UTC instant. DST-safe. */
export function zonedToIso(ymd: string, hhmm: string, tz: string): string {
  const [y, mo, d] = ymd.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  const target = Date.UTC(y, mo - 1, d, h, mi);
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(new Date(guess), tz);
    const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm);
    const diff = asUtc - target;
    if (diff === 0) break;
    guess -= diff;
  }
  return new Date(guess).toISOString();
}

/** Splits an instant into tz-local {date: 'YYYY-MM-DD', time: 'HH:MM'} for form inputs. */
export function isoToLocalInputs(v: DateLike, tz: string): { date: string; time: string } {
  const d = toDate(v) ?? new Date();
  const p = zonedParts(d, tz);
  return { date: `${p.y}-${pad(p.m)}-${pad(p.d)}`, time: `${pad(p.hh)}:${pad(p.mm)}` };
}

/** "09:00" → "9:00 am" (shift times are already local). */
export function fmtClock(hhmm: string | null | undefined): string {
  if (!hhmm) return '—';
  const [h, m] = hhmm.split(':').map(Number);
  const suffix = h >= 12 ? 'pm' : 'am';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${pad(m)} ${suffix}`;
}

export function initials(name: string | null | undefined): string {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  const first = parts[0][0] ?? '';
  const last = parts.length > 1 ? parts[parts.length - 1][0] ?? '' : '';
  return (first + last).toUpperCase();
}

export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function fmtDays(days: number[]): string {
  const s = [...days].sort((a, b) => a - b);
  if (s.length === 7) return 'Every day';
  if (s.join() === '1,2,3,4,5') return 'Mon–Fri';
  if (s.join() === '6,7') return 'Weekends';
  // Collapse consecutive runs: Mon–Thu, Sat
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    out.push(j - i >= 2 ? `${WEEKDAYS[s[i] - 1]}–${WEEKDAYS[s[j] - 1]}` : s.slice(i, j + 1).map((x) => WEEKDAYS[x - 1]).join(', '));
    i = j + 1;
  }
  return out.join(', ');
}
