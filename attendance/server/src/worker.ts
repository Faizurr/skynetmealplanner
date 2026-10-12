import type { Config } from './config.js';
import type { Db } from './db.js';
import { withTenant } from './db.js';
import type { Mailer } from './mailer.js';
import { flagMissingCheckout, loadRestaurant, raiseException, type SessionRow } from './attendance.js';
import { enqueueNotification, loadNotificationSettings, renderEmail } from './notifications.js';
import { dailySummaryRows, overview } from './analytics.js';
import { formatDate, formatTime, localDate, toLocalParts, timeToMinutes } from './time.js';
import { audit } from './audit.js';

/** Exponential backoff with cap: 1m, 2m, 4m, … 60m. */
export function backoffMs(attempt: number): number {
  return Math.min(60, 2 ** Math.max(0, attempt - 1)) * 60_000;
}

export class Worker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly db: Db,
    private readonly cfg: Config,
    private readonly mailer: Mailer | null,
  ) {}

  start() {
    const loop = async () => {
      await this.tick().catch((err) => console.error('[worker] tick failed', err));
      this.timer = setTimeout(loop, this.cfg.WORKER_INTERVAL_MS);
    };
    this.timer = setTimeout(loop, 1000);
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async tick(now = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const ids = (await this.db.query<{ id: string }>('SELECT list_restaurant_ids() AS id')).rows.map((r) => r.id);
      for (const id of ids) {
        await this.scanRestaurant(id, now).catch((err) => console.error(`[worker] scan ${id} failed`, err));
      }
      await this.deliverOutbox();
    } finally {
      this.running = false;
    }
  }

  /** Missing checkouts, offline kiosks and daily summaries for one restaurant. */
  async scanRestaurant(restaurantId: string, now = new Date()): Promise<void> {
    await withTenant(this.db, restaurantId, async (tx) => {
      const r = await loadRestaurant(tx, restaurantId, this.cfg.PUBLIC_BASE_URL);
      const s = r.settings;

      // Missing checkouts.
      const open = await tx.query<SessionRow & { full_name: string; staff_id: string }>(
        `SELECT s.id, s.employee_id, s.branch_id, s.status, s.check_in_at, s.check_out_at, s.shift_id, s.scheduled_start,
                s.scheduled_end, s.late_minutes, s.is_late, s.worked_minutes, s.break_minutes, s.overtime_minutes,
                e.full_name, e.staff_id
           FROM attendance_sessions s JOIN employees e ON e.id = s.employee_id
          WHERE s.restaurant_id = $1 AND s.status = 'open'
            AND (s.check_in_at < $2::timestamptz - make_interval(hours => $3)
                 OR (s.scheduled_end IS NOT NULL AND s.scheduled_end < $2::timestamptz - make_interval(mins => $4)))
          FOR UPDATE OF s SKIP LOCKED`,
        [restaurantId, now, s.max_session_hours, s.missing_checkout_grace_minutes],
      );
      for (const row of open.rows) {
        const tooLong = now.getTime() - row.check_in_at.getTime() > s.max_session_hours * 3_600_000;
        await flagMissingCheckout(tx, r, row, row, tooLong ? 'exceeded_max_session_hours' : 'past_scheduled_end', tooLong);
      }

      // Offline kiosks (alert once per outage).
      const offline = await tx.query<{ id: string; name: string; last_seen_at: Date; pending_queue_count: number }>(
        `SELECT id, name, last_seen_at, pending_queue_count FROM devices
          WHERE restaurant_id = $1 AND status = 'active' AND last_seen_at IS NOT NULL
            AND last_seen_at < $2::timestamptz - make_interval(mins => $3)
            AND (offline_alerted_at IS NULL OR offline_alerted_at < last_seen_at)
          FOR UPDATE SKIP LOCKED`,
        [restaurantId, now, this.cfg.DEVICE_OFFLINE_MINUTES],
      );
      for (const d of offline.rows) {
        const key = `device_offline:${d.id}:${d.last_seen_at.getTime()}`;
        await tx.query('UPDATE devices SET offline_alerted_at = $2 WHERE id = $1', [d.id, now]);
        await raiseException(tx, r.id, {
          kind: 'device_offline', severity: 'warning', dedupeKey: key, deviceId: d.id,
          details: { last_seen_at: d.last_seen_at.toISOString(), pending_queue_count: d.pending_queue_count },
        });
        await enqueueNotification(tx, r.id, r.timezone, 'device_offline', key, () =>
          renderEmail({
            restaurantName: r.name,
            heading: `Attendance kiosk offline: ${d.name}`,
            intro: `The kiosk has not contacted the server since ${formatTime(d.last_seen_at, r.timezone)} on ${formatDate(d.last_seen_at, r.timezone)}. Employees can keep checking in if offline mode is on; their records will sync when the connection returns.`,
            rows: [
              ['Kiosk', d.name],
              ['Last seen', `${formatDate(d.last_seen_at, r.timezone)} ${formatTime(d.last_seen_at, r.timezone)}`],
              ['Unsynced events at last contact', String(d.pending_queue_count)],
            ],
            link: { href: `${r.publicBaseUrl}/#/devices`, label: 'View devices' },
            footnote: 'Check the device power, Wi-Fi and that the attendance app is open.',
          }),
          now,
        );
      }

      // Daily summary (once per local day, after the configured time).
      const ns = await loadNotificationSettings(tx, restaurantId);
      if (ns.daily_summary && ns.emails.length) {
        const today = localDate(now, r.timezone);
        const lp = toLocalParts(now, r.timezone);
        if (lp.hour * 60 + lp.minute >= timeToMinutes(ns.daily_summary_time)) {
          const key = `daily_summary:${today}`;
          const exists = await tx.query('SELECT 1 FROM notification_outbox WHERE restaurant_id = $1 AND dedupe_key = $2', [restaurantId, key]);
          if (!exists.rowCount) {
            const o = await overview(tx, r, today, null, this.cfg.DEVICE_OFFLINE_MINUTES);
            await enqueueNotification(tx, r.id, r.timezone, 'daily_summary', key, () =>
              renderEmail({
                restaurantName: r.name,
                heading: `Daily attendance summary — ${formatDate(now, r.timezone)}`,
                rows: dailySummaryRows(o, r.timezone),
                link: { href: `${r.publicBaseUrl}/#/`, label: 'Open dashboard' },
                footnote: 'Hours shown in the dashboard are provisional until corrections are reviewed.',
              }),
              now,
            );
          }
        }
      }
    });
  }

  /** Claims due emails with SKIP LOCKED (safe with several instances), sends, records the outcome. */
  async deliverOutbox(limit = 25): Promise<number> {
    const restaurants = (await this.db.query<{ id: string }>('SELECT due_outbox_restaurants() AS id')).rows.map((r) => r.id);
    let processed = 0;
    for (const rid of restaurants) {
      const claimed = await withTenant(this.db, rid, async (tx) => {
        const rows = await tx.query<{ id: string; to_addresses: string[]; subject: string; text_body: string; html_body: string; attempts: number; max_attempts: number; dedupe_key: string }>(
          `SELECT id, to_addresses, subject, text_body, html_body, attempts, max_attempts, dedupe_key FROM notification_outbox
            WHERE restaurant_id = $1 AND status IN ('queued', 'sending') AND next_attempt_at <= now()
            ORDER BY created_at LIMIT $2 FOR UPDATE SKIP LOCKED`,
          [rid, limit],
        );
        // Lease: if this process dies mid-send, the row becomes due again in 5 minutes.
        for (const row of rows.rows) {
          await tx.query(
            `UPDATE notification_outbox SET status = 'sending', attempts = attempts + 1, next_attempt_at = now() + interval '5 minutes' WHERE id = $1`,
            [row.id],
          );
        }
        return rows.rows;
      });
      for (const msg of claimed) {
        processed++;
        const attempt = msg.attempts + 1;
        if (!this.mailer) {
          await withTenant(this.db, rid, (tx) =>
            tx.query(`UPDATE notification_outbox SET status = 'suppressed', last_error = 'Email delivery is disabled (EMAIL_TRANSPORT=disabled)' WHERE id = $1`, [msg.id]),
          );
          continue;
        }
        try {
          const res = await this.mailer.send({ to: msg.to_addresses, subject: msg.subject, text: msg.text_body, html: msg.html_body, idempotencyKey: `${rid}:${msg.dedupe_key}` });
          await withTenant(this.db, rid, (tx) =>
            tx.query(`UPDATE notification_outbox SET status = 'sent', sent_at = now(), provider_message_id = $2, last_error = NULL WHERE id = $1`, [msg.id, res.messageId]),
          );
        } catch (err) {
          const message = (err as Error).message.slice(0, 500);
          const final = attempt >= msg.max_attempts;
          await withTenant(this.db, rid, async (tx) => {
            await tx.query(
              `UPDATE notification_outbox SET status = $2, last_error = $3, next_attempt_at = now() + make_interval(secs => $4) WHERE id = $1`,
              [msg.id, final ? 'failed' : 'queued', message, backoffMs(attempt) / 1000],
            );
            if (final) await audit(tx, rid, { type: 'system', id: null }, 'notification.failed', { type: 'notification', id: msg.id }, { error: message, attempts: attempt });
          });
        }
      }
    }
    return processed;
  }
}
