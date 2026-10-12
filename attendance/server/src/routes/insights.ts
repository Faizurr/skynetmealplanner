import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTenant } from '../db.js';
import { loadRestaurant } from '../attendance.js';
import { analytics, overview } from '../analytics.js';
import { formatLocal, localDate } from '../time.js';
import { roundMinutes } from '../settings.js';
import { audit } from '../audit.js';
import { HttpError, parse, requireUser, uuid, ymd, type AppCtx } from '../http.js';

export function csvCell(v: unknown): string {
  if (v == null) return '';
  let s = v instanceof Date ? v.toISOString() : String(v);
  // Neutralise spreadsheet formula injection.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

function daySpan(from: string, to: string) {
  const ms = Date.parse(to) - Date.parse(from);
  if (ms < 0) throw new HttpError(400, 'invalid_range', '"from" must be on or before "to"');
  if (ms > 400 * 86400_000) throw new HttpError(400, 'invalid_range', 'Range cannot exceed 400 days');
}

export function registerInsightRoutes(app: FastifyInstance, ctx: AppCtx) {
  app.get('/api/overview', { preHandler: requireUser(ctx, 'attendance.read') }, async (req) => {
    const a = req.userAuth!;
    const q = parse(z.object({ date: ymd.optional(), branch_id: uuid.optional() }), req.query);
    return withTenant(ctx.db, a.restaurantId, async (tx) => {
      const r = await loadRestaurant(tx, a.restaurantId, ctx.cfg.PUBLIC_BASE_URL);
      return overview(tx, r, q.date ?? localDate(new Date(), r.timezone), q.branch_id ?? null, ctx.cfg.DEVICE_OFFLINE_MINUTES);
    });
  });

  app.get('/api/analytics', { preHandler: requireUser(ctx, 'attendance.read') }, async (req) => {
    const a = req.userAuth!;
    const q = parse(z.object({ from: ymd, to: ymd, branch_id: uuid.optional() }), req.query);
    daySpan(q.from, q.to);
    return withTenant(ctx.db, a.restaurantId, async (tx) => {
      const r = await loadRestaurant(tx, a.restaurantId, ctx.cfg.PUBLIC_BASE_URL);
      return analytics(tx, r, q.from, q.to, q.branch_id ?? null);
    });
  });

  /** Payroll-oriented timesheet. Clearly marked provisional. */
  app.get('/api/reports/timesheet.csv', { preHandler: requireUser(ctx, 'reports.export') }, async (req, reply) => {
    const a = req.userAuth!;
    const q = parse(z.object({ from: ymd, to: ymd, employee_id: uuid.optional(), branch_id: uuid.optional(), shift_id: uuid.optional() }), req.query);
    daySpan(q.from, q.to);
    const csv = await withTenant(ctx.db, a.restaurantId, async (tx) => {
      const r = await loadRestaurant(tx, a.restaurantId, ctx.cfg.PUBLIC_BASE_URL);
      const rows = (await tx.query(
        `SELECT e.staff_id, e.full_name, b.name AS branch, sh.name AS shift, s.status, s.is_corrected, s.needs_review,
                COALESCE(s.corrected_check_in_at, s.check_in_at) AS cin, COALESCE(s.corrected_check_out_at, s.check_out_at) AS cout,
                s.scheduled_start, s.late_minutes, s.break_minutes, s.worked_minutes, s.overtime_minutes
           FROM attendance_sessions s JOIN employees e ON e.id = s.employee_id
           LEFT JOIN branches b ON b.id = s.branch_id LEFT JOIN shifts sh ON sh.id = s.shift_id
          WHERE s.restaurant_id = $1 AND s.status <> 'voided'
            AND COALESCE(s.corrected_check_in_at, s.check_in_at) >= ($2::date)::timestamp AT TIME ZONE $4
            AND COALESCE(s.corrected_check_in_at, s.check_in_at) < ($3::date + 1)::timestamp AT TIME ZONE $4
            AND ($5::uuid IS NULL OR s.employee_id = $5) AND ($6::uuid IS NULL OR s.branch_id = $6) AND ($7::uuid IS NULL OR s.shift_id = $7)
          ORDER BY e.full_name, cin`,
        [a.restaurantId, q.from, q.to, r.timezone, q.employee_id ?? null, q.branch_id ?? null, q.shift_id ?? null],
      )).rows;
      const fmt = (d: Date | null) => (d ? formatLocal(d, r.timezone, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '');
      const step = r.settings.rounding_minutes;
      const out = toCsv(
        ['Staff ID', 'Name', 'Branch', 'Shift', 'Date', 'Check-in', 'Check-out', 'Scheduled start', 'Late (min)', 'Unpaid break (min)', 'Worked (min)', `Worked rounded (min, ${step || 'none'} ${r.settings.rounding_mode})`, 'Worked (h)', 'Overtime (min)', 'Status', 'Corrected', 'Needs review'],
        rows.map((x) => [
          x.staff_id, x.full_name, x.branch, x.shift, localDate(x.cin, r.timezone), fmt(x.cin), fmt(x.cout), fmt(x.scheduled_start), x.late_minutes, x.break_minutes,
          x.worked_minutes, x.worked_minutes == null ? '' : roundMinutes(x.worked_minutes, step, r.settings.rounding_mode),
          x.worked_minutes == null ? '' : (x.worked_minutes / 60).toFixed(2), x.overtime_minutes, x.status, x.is_corrected ? 'yes' : 'no', x.needs_review ? 'yes' : 'no',
        ]),
      );
      await audit(tx, a.restaurantId, { type: 'user', id: a.userId, ip: req.ip }, 'report.exported', { type: 'report' }, { report: 'timesheet', from: q.from, to: q.to });
      return `# PROVISIONAL attendance-derived timesheet for ${r.name} (${q.from} to ${q.to}, ${r.timezone}). Review corrections and payroll policy before use.\r\n${out}`;
    });
    reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="timesheet-${q.from}-to-${q.to}.csv"`);
    return csv;
  });

  app.get('/api/reports/events.csv', { preHandler: requireUser(ctx, 'reports.export') }, async (req, reply) => {
    const a = req.userAuth!;
    const q = parse(z.object({ from: ymd, to: ymd, employee_id: uuid.optional(), branch_id: uuid.optional() }), req.query);
    daySpan(q.from, q.to);
    const csv = await withTenant(ctx.db, a.restaurantId, async (tx) => {
      const r = await loadRestaurant(tx, a.restaurantId, ctx.cfg.PUBLIC_BASE_URL);
      const rows = (await tx.query(
        `SELECT ev.id, e.staff_id, e.full_name, ev.event_type, ev.event_time, ev.device_timestamp, ev.server_received_at, ev.source,
                ev.verification_status, ev.recorded_offline, ev.exception_flags, b.name AS branch, d.name AS device
           FROM attendance_events ev JOIN employees e ON e.id = ev.employee_id LEFT JOIN branches b ON b.id = ev.branch_id LEFT JOIN devices d ON d.id = ev.device_id
          WHERE ev.restaurant_id = $1 AND ev.event_time >= ($2::date)::timestamp AT TIME ZONE $4 AND ev.event_time < ($3::date + 1)::timestamp AT TIME ZONE $4
            AND ($5::uuid IS NULL OR ev.employee_id = $5) AND ($6::uuid IS NULL OR ev.branch_id = $6)
          ORDER BY ev.event_time`,
        [a.restaurantId, q.from, q.to, r.timezone, q.employee_id ?? null, q.branch_id ?? null],
      )).rows;
      const fmt = (d: Date | null) => (d ? formatLocal(d, r.timezone, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '');
      await audit(tx, a.restaurantId, { type: 'user', id: a.userId, ip: req.ip }, 'report.exported', { type: 'report' }, { report: 'events', from: q.from, to: q.to });
      return toCsv(
        ['Event ID', 'Staff ID', 'Name', 'Type', 'Event time (local)', 'Device time (local)', 'Server received (UTC)', 'Source', 'Verification', 'Recorded offline', 'Flags', 'Branch', 'Device'],
        rows.map((x) => [x.id, x.staff_id, x.full_name, x.event_type, fmt(x.event_time), fmt(x.device_timestamp), x.server_received_at, x.source, x.verification_status, x.recorded_offline ? 'yes' : 'no', x.exception_flags.join(' '), x.branch, x.device]),
      );
    });
    reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="attendance-events-${q.from}-to-${q.to}.csv"`);
    return csv;
  });

  app.get('/api/reports/summary.csv', { preHandler: requireUser(ctx, 'reports.export') }, async (req, reply) => {
    const a = req.userAuth!;
    const q = parse(z.object({ from: ymd, to: ymd, branch_id: uuid.optional() }), req.query);
    daySpan(q.from, q.to);
    const csv = await withTenant(ctx.db, a.restaurantId, async (tx) => {
      const r = await loadRestaurant(tx, a.restaurantId, ctx.cfg.PUBLIC_BASE_URL);
      const an = await analytics(tx, r, q.from, q.to, q.branch_id ?? null);
      return toCsv(
        ['Staff ID', 'Name', 'Scheduled shifts', 'Attended', 'Absences', 'Late', 'Avg lateness (min)', 'Punctuality %', 'Consistency %', 'Worked (h)', 'Overtime (h)', 'Missing check-outs'],
        an.employees.map((e) => [e.staff_id, e.full_name, e.scheduled, e.attended, e.absences, e.late, e.average_lateness_minutes ?? '', e.punctuality_rate ?? '', e.consistency ?? '', (e.worked_minutes / 60).toFixed(2), (e.overtime_minutes / 60).toFixed(2), e.missing_checkouts]),
      );
    });
    reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="attendance-summary-${q.from}-to-${q.to}.csv"`);
    return csv;
  });
}
