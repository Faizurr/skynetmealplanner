import type { Tx } from './db.js';
import { formatDate, formatTime, inLocalWindow, timeToMinutes, toLocalParts, localDate, addDays, zonedToUtc } from './time.js';

export type NotificationKind =
  | 'check_in'
  | 'check_out'
  | 'late_arrival'
  | 'missing_checkout'
  | 'unknown_face'
  | 'suspicious_event'
  | 'device_offline'
  | 'sync_failure'
  | 'daily_summary'
  | 'test';

export interface NotificationSettingsRow {
  emails: string[];
  on_check_in: boolean;
  on_check_out: boolean;
  important_only: boolean;
  late_arrival: boolean;
  missing_checkout: boolean;
  unknown_face: boolean;
  suspicious_events: boolean;
  device_offline: boolean;
  sync_failure: boolean;
  daily_summary: boolean;
  daily_summary_time: string;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
  include_staff_id: boolean;
}

const IMPORTANT: Set<NotificationKind> = new Set([
  'late_arrival', 'missing_checkout', 'unknown_face', 'suspicious_event', 'device_offline', 'sync_failure', 'daily_summary', 'test',
]);
/** Delivered even during quiet hours. */
const BYPASS_QUIET: Set<NotificationKind> = new Set(['suspicious_event', 'test']);

export function isEnabled(s: NotificationSettingsRow, kind: NotificationKind): boolean {
  if (s.emails.length === 0) return false;
  if (s.important_only && !IMPORTANT.has(kind)) return false;
  switch (kind) {
    case 'check_in': return s.on_check_in;
    case 'check_out': return s.on_check_out;
    case 'late_arrival': return s.late_arrival;
    case 'missing_checkout': return s.missing_checkout;
    case 'unknown_face': return s.unknown_face;
    case 'suspicious_event': return s.suspicious_events;
    case 'device_offline': return s.device_offline;
    case 'sync_failure': return s.sync_failure;
    case 'daily_summary': return s.daily_summary;
    case 'test': return true;
  }
}

/** If now is inside quiet hours, returns the instant they end; otherwise null. */
export function quietHoursRelease(s: NotificationSettingsRow, now: Date, tz: string): Date | null {
  if (!s.quiet_hours_start || !s.quiet_hours_end) return null;
  const start = timeToMinutes(s.quiet_hours_start);
  const end = timeToMinutes(s.quiet_hours_end);
  if (start === end) return null;
  const p = toLocalParts(now, tz);
  const t = p.hour * 60 + p.minute;
  if (!inLocalWindow(t, start, end)) return null;
  const today = localDate(now, tz);
  const endDay = start < end || t < end ? today : addDays(today, 1);
  return zonedToUtc(endDay, s.quiet_hours_end, tz);
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export interface EmailContent {
  subject: string;
  text: string;
  html: string;
}

/** Simple, accessible transactional template. Never contains facial images or templates. */
export function renderEmail(opts: {
  restaurantName: string;
  heading: string;
  rows: [string, string][];
  intro?: string;
  link?: { href: string; label: string };
  footnote?: string;
}): EmailContent {
  const text = [
    opts.heading,
    '',
    ...(opts.intro ? [opts.intro, ''] : []),
    ...opts.rows.map(([k, v]) => `${k}: ${v}`),
    ...(opts.link ? ['', `${opts.link.label}: ${opts.link.href}`] : []),
    ...(opts.footnote ? ['', opts.footnote] : []),
    '',
    `— ${opts.restaurantName} attendance`,
  ].join('\n');
  const rowsHtml = opts.rows
    .map(
      ([k, v]) =>
        `<tr><td style="padding:6px 16px 6px 0;color:#6b7280;font-size:14px;white-space:nowrap">${escapeHtml(k)}</td><td style="padding:6px 0;font-size:14px;color:#111827;font-weight:500">${escapeHtml(v)}</td></tr>`,
    )
    .join('');
  const html = `<!doctype html><html><body style="margin:0;background:#f4f4f5;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" style="max-width:520px;background:#ffffff;border-radius:12px;border:1px solid #e4e4e7" cellpadding="0" cellspacing="0">
<tr><td style="padding:24px 24px 8px"><div style="font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#71717a">${escapeHtml(opts.restaurantName)}</div>
<h1 style="margin:6px 0 0;font-size:20px;color:#111827">${escapeHtml(opts.heading)}</h1>
${opts.intro ? `<p style="margin:12px 0 0;font-size:14px;color:#374151;line-height:1.5">${escapeHtml(opts.intro)}</p>` : ''}</td></tr>
<tr><td style="padding:8px 24px 8px"><table role="presentation" cellpadding="0" cellspacing="0">${rowsHtml}</table></td></tr>
${opts.link ? `<tr><td style="padding:8px 24px 24px"><a href="${escapeHtml(opts.link.href)}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:8px;font-size:14px;font-weight:600">${escapeHtml(opts.link.label)}</a></td></tr>` : ''}
${opts.footnote ? `<tr><td style="padding:0 24px 24px;font-size:12px;color:#71717a;line-height:1.5">${escapeHtml(opts.footnote)}</td></tr>` : ''}
</table></td></tr></table></body></html>`;
  return { subject: opts.heading, text, html };
}

export async function loadNotificationSettings(tx: Tx, restaurantId: string): Promise<NotificationSettingsRow> {
  const r = await tx.query<NotificationSettingsRow>(
    `SELECT emails, on_check_in, on_check_out, important_only, late_arrival, missing_checkout, unknown_face,
            suspicious_events, device_offline, sync_failure, daily_summary, daily_summary_time::text,
            quiet_hours_start::text, quiet_hours_end::text, include_staff_id
       FROM notification_settings WHERE restaurant_id = $1`,
    [restaurantId],
  );
  return (
    r.rows[0] ?? {
      emails: [], on_check_in: true, on_check_out: true, important_only: false, late_arrival: true,
      missing_checkout: true, unknown_face: true, suspicious_events: true, device_offline: true,
      sync_failure: true, daily_summary: true, daily_summary_time: '22:00:00', quiet_hours_start: null,
      quiet_hours_end: null, include_staff_id: true,
    }
  );
}

/**
 * Transactional outbox: the notification row commits atomically with the attendance
 * change, and the worker delivers it later. A failing email provider can therefore
 * never block or roll back attendance. dedupe_key makes enqueueing idempotent.
 */
export async function enqueueNotification(
  tx: Tx,
  restaurantId: string,
  tz: string,
  kind: NotificationKind,
  dedupeKey: string,
  build: (s: NotificationSettingsRow) => EmailContent,
  now = new Date(),
): Promise<'queued' | 'disabled' | 'duplicate'> {
  const s = await loadNotificationSettings(tx, restaurantId);
  if (!isEnabled(s, kind)) return 'disabled';
  const content = build(s);
  const release = BYPASS_QUIET.has(kind) ? null : quietHoursRelease(s, now, tz);
  const r = await tx.query(
    `INSERT INTO notification_outbox (restaurant_id, kind, dedupe_key, to_addresses, subject, text_body, html_body, next_attempt_at, not_before)
     VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, now()), $8)
     ON CONFLICT (restaurant_id, dedupe_key) DO NOTHING`,
    [restaurantId, kind, dedupeKey, s.emails, content.subject, content.text, content.html, release],
  );
  return r.rowCount ? 'queued' : 'duplicate';
}

export function eventEmailRows(
  s: NotificationSettingsRow,
  e: { employeeName: string; staffId: string; type: string; at: Date; tz: string; branch: string | null; status: string },
): [string, string][] {
  const rows: [string, string][] = [['Employee', e.employeeName]];
  if (s.include_staff_id) rows.push(['Employee ID', e.staffId]);
  rows.push(['Event', e.type], ['Date', formatDate(e.at, e.tz)], ['Time', formatTime(e.at, e.tz)]);
  if (e.branch) rows.push(['Branch', e.branch]);
  rows.push(['Status', e.status]);
  return rows;
}
