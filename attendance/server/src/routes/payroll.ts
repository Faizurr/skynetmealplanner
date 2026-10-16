import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTenant } from '../db.js';
import { audit } from '../audit.js';
import { loadRestaurant } from '../attendance.js';
import { computePay, currentRateCents, refreshPendingPayouts, syncPayoutForSession, toCents } from '../payroll.js';
import { leaderboard } from '../leaderboard.js';
import { localDate, formatLocal, addDays } from '../time.js';
import { HttpError, notFound, parse, requireUser, uuid, ymd, type AppCtx } from '../http.js';
import { toCsv } from './insights.js';

const PAYOUT_SELECT = `
  SELECT p.id, p.employee_id, e.full_name, e.preferred_name, e.staff_id,
         EXISTS (SELECT 1 FROM employee_photos ph WHERE ph.employee_id = e.id) AS has_photo,
         p.session_id, p.work_date, p.check_in_at, p.check_out_at, p.worked_minutes, p.standard_minutes, p.ot_minutes,
         p.daily_rate_cents, p.base_cents, p.ot_cents, p.adjustment_cents, p.adjustment_reason, p.total_cents,
         p.rate_missing, p.needs_review, p.review_reason, p.status, p.method, p.pay_note, p.paid_at,
         u.full_name AS paid_by, EXISTS (SELECT 1 FROM payout_proofs pp WHERE pp.payout_id = p.id) AS has_proof,
         p.created_at, p.updated_at
    FROM payouts p JOIN employees e ON e.id = p.employee_id LEFT JOIN users u ON u.id = p.paid_by_user_id`;

const IMAGE_MAGIC: [string, (b: Buffer) => boolean][] = [
  ['image/jpeg', (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['image/png', (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ['image/webp', (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP'],
];

function decodePhoto(b64: string): { mime: string; data: Buffer } {
  const data = Buffer.from(b64.replace(/^data:image\/[a-z]+;base64,/, ''), 'base64');
  if (data.length < 100) throw new HttpError(400, 'invalid_photo', 'The photo could not be read. Please take it again.');
  if (data.length > 4 * 1024 * 1024) throw new HttpError(413, 'photo_too_large', 'The photo is too large (max 4 MB).');
  const kind = IMAGE_MAGIC.find(([, test]) => test(data));
  if (!kind) throw new HttpError(400, 'invalid_photo', 'Only JPEG, PNG or WebP photos are accepted.');
  return { mime: kind[0], data };
}

const money = (min: number, max: number) =>
  z.number().finite().min(min).max(max).refine((n) => Math.abs(Math.round(n * 100) - n * 100) < 1e-6, 'Use at most 2 decimals');

export function registerPayrollRoutes(app: FastifyInstance, ctx: AppCtx) {
  // ------------------------------------------------------------------ Salary rates (boss only to change)
  app.get('/api/payroll/rates', { preHandler: requireUser(ctx, 'payroll.view') }, async (req) => {
    const a = req.userAuth!;
    return withTenant(ctx.db, a.restaurantId, async (tx) => {
      const r = await loadRestaurant(tx, a.restaurantId, ctx.cfg.PUBLIC_BASE_URL);
      const today = localDate(new Date(), r.timezone);
      const rows = (await tx.query(
        `SELECT e.id AS employee_id, e.full_name, e.preferred_name, e.staff_id, e.job_title,
                EXISTS (SELECT 1 FROM employee_photos ph WHERE ph.employee_id = e.id) AS has_photo,
                cur.daily_rate_cents, cur.effective_from, nxt.daily_rate_cents AS upcoming_rate_cents, nxt.effective_from AS upcoming_from
           FROM employees e
           LEFT JOIN LATERAL (SELECT daily_rate_cents, effective_from FROM employee_pay_rates WHERE employee_id = e.id AND effective_from <= $2::date ORDER BY effective_from DESC LIMIT 1) cur ON true
           LEFT JOIN LATERAL (SELECT daily_rate_cents, effective_from FROM employee_pay_rates WHERE employee_id = e.id AND effective_from > $2::date ORDER BY effective_from LIMIT 1) nxt ON true
          WHERE e.restaurant_id = $1 AND e.status = 'active' ORDER BY e.full_name`,
        [a.restaurantId, today],
      )).rows;
      return { standard_hours: r.settings.payroll_standard_hours, short_day_policy: r.settings.payroll_short_day_policy, currency: r.settings.currency, today, employees: rows };
    });
  });

  app.get('/api/employees/:id/rates', { preHandler: requireUser(ctx, 'payroll.view') }, async (req) => {
    const a = req.userAuth!;
    const { id } = parse(z.object({ id: uuid }), req.params);
    return withTenant(ctx.db, a.restaurantId, async (tx) => ({
      rates: (await tx.query(
        `SELECT r.daily_rate_cents, r.effective_from, r.created_at, u.full_name AS set_by FROM employee_pay_rates r
           LEFT JOIN users u ON u.id = r.created_by_user_id WHERE r.employee_id = $1 AND r.restaurant_id = $2 ORDER BY r.effective_from DESC`,
        [id, a.restaurantId],
      )).rows,
    }));
  });

  app.put('/api/employees/:id/rate', { preHandler: requireUser(ctx, 'payroll.rates') }, async (req) => {
    const a = req.userAuth!;
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(z.object({ daily_rate: money(0, 1_000_000), effective_from: ymd.optional() }), req.body);
    return withTenant(ctx.db, a.restaurantId, async (tx) => {
      const r = await loadRestaurant(tx, a.restaurantId, ctx.cfg.PUBLIC_BASE_URL);
      const emp = (await tx.query('SELECT id FROM employees WHERE id = $1 AND restaurant_id = $2', [id, a.restaurantId])).rows[0];
      if (!emp) throw notFound('Employee');
      const from = b.effective_from ?? localDate(new Date(), r.timezone);
      const cents = toCents(b.daily_rate);
      const before = await currentRateCents(tx, id, from);
      await tx.query(
        `INSERT INTO employee_pay_rates (restaurant_id, employee_id, daily_rate_cents, effective_from, created_by_user_id) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (employee_id, effective_from) DO UPDATE SET daily_rate_cents = EXCLUDED.daily_rate_cents, created_by_user_id = EXCLUDED.created_by_user_id, created_at = now()`,
        [a.restaurantId, id, cents, from, a.userId],
      );
      const refreshed = await refreshPendingPayouts(tx, r, id, from);
      await audit(tx, a.restaurantId, { type: 'user', id: a.userId, ip: req.ip }, 'payroll.rate_set', { type: 'employee', id }, {
        daily_rate_cents: cents, previous_cents: before, effective_from: from, pending_payouts_refreshed: refreshed,
      });
      const pay = computePay({ workedMinutes: 0, dailyRateCents: cents, settings: r.settings });
      return { ok: true, daily_rate_cents: cents, hourly_ot_cents: pay.hourlyCents, effective_from: from, pending_payouts_refreshed: refreshed };
    });
  });

  // ------------------------------------------------------------------ Payouts
  app.get('/api/payouts', { preHandler: requireUser(ctx, 'payroll.view') }, async (req) => {
    const a = req.userAuth!;
    const q = parse(
      z.object({
        status: z.enum(['pending', 'paid', 'void', 'all']).default('pending'),
        employee_id: uuid.optional(),
        from: ymd.optional(),
        to: ymd.optional(),
        limit: z.coerce.number().int().min(1).max(500).default(200),
        id: uuid.optional(),
      }),
      req.query,
    );
    return withTenant(ctx.db, a.restaurantId, async (tx) => {
      const r = await loadRestaurant(tx, a.restaurantId, ctx.cfg.PUBLIC_BASE_URL);
      const today = localDate(new Date(), r.timezone);
      const monthStart = `${today.slice(0, 7)}-01`;
      const payouts = (await tx.query(
        `${PAYOUT_SELECT}
          WHERE p.restaurant_id = $1 AND ($2 = 'all' OR p.status::text = $2) AND ($3::uuid IS NULL OR p.employee_id = $3)
            AND ($4::date IS NULL OR p.work_date >= $4) AND ($5::date IS NULL OR p.work_date <= $5) AND ($7::uuid IS NULL OR p.id = $7)
          ORDER BY CASE WHEN p.status = 'pending' THEN 0 ELSE 1 END, COALESCE(p.paid_at, p.check_out_at) DESC LIMIT $6`,
        [a.restaurantId, q.status, q.employee_id ?? null, q.from ?? null, q.to ?? null, q.limit, q.id ?? null],
      )).rows;
      const summary = (await tx.query(
        `SELECT count(*) FILTER (WHERE status = 'pending')::int AS pending_count,
                COALESCE(sum(total_cents) FILTER (WHERE status = 'pending'), 0)::int AS pending_cents,
                count(*) FILTER (WHERE status = 'pending' AND rate_missing)::int AS rate_missing_count,
                count(*) FILTER (WHERE needs_review AND status <> 'void')::int AS needs_review_count,
                COALESCE(sum(total_cents) FILTER (WHERE status = 'paid' AND paid_at >= ($2::date)::timestamp AT TIME ZONE $3), 0)::int AS paid_month_cents,
                COALESCE(sum(total_cents) FILTER (WHERE status = 'paid' AND method = 'cash' AND paid_at >= ($2::date)::timestamp AT TIME ZONE $3), 0)::int AS paid_month_cash_cents,
                COALESCE(sum(total_cents) FILTER (WHERE status = 'paid' AND method = 'qr' AND paid_at >= ($2::date)::timestamp AT TIME ZONE $3), 0)::int AS paid_month_qr_cents
           FROM payouts WHERE restaurant_id = $1`,
        [a.restaurantId, monthStart, r.timezone],
      )).rows[0];
      const byEmployee = (await tx.query(
        `SELECT p.employee_id, e.full_name, e.preferred_name, count(*)::int AS count, sum(p.total_cents)::int AS cents, min(p.work_date) AS oldest
           FROM payouts p JOIN employees e ON e.id = p.employee_id
          WHERE p.restaurant_id = $1 AND p.status = 'pending' GROUP BY p.employee_id, e.full_name, e.preferred_name ORDER BY cents DESC`,
        [a.restaurantId],
      )).rows;
      return { currency: r.settings.currency, standard_hours: r.settings.payroll_standard_hours, summary, pending_by_employee: byEmployee, payouts };
    });
  });

  app.get('/api/payouts/:id/proof', { preHandler: requireUser(ctx, 'payroll.view') }, async (req, reply) => {
    const a = req.userAuth!;
    const { id } = parse(z.object({ id: uuid }), req.params);
    const row = await withTenant(ctx.db, a.restaurantId, async (tx) => (await tx.query<{ mime: string; data: Buffer }>('SELECT mime, data FROM payout_proofs WHERE payout_id = $1 AND restaurant_id = $2', [id, a.restaurantId])).rows[0]);
    if (!row) throw notFound('Payment proof');
    reply.header('Cache-Control', 'private, max-age=600').type(row.mime);
    return reply.send(row.data);
  });

  /** Settle a payout. Cash requires a photo of the signed payslip; QR accepts an optional screenshot. */
  app.post('/api/payouts/:id/pay', { preHandler: requireUser(ctx, 'payroll.pay'), bodyLimit: 6 * 1024 * 1024 }, async (req) => {
    const a = req.userAuth!;
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(z.object({ method: z.enum(['cash', 'qr']), photo_base64: z.string().max(6_000_000).optional().nullable(), note: z.string().trim().max(300).optional().nullable() }), req.body);
    const photo = b.photo_base64 ? decodePhoto(b.photo_base64) : null;
    return withTenant(ctx.db, a.restaurantId, async (tx) => {
      const p = (await tx.query<{ status: string; rate_missing: boolean; total_cents: number; employee_id: string }>(
        'SELECT status, rate_missing, total_cents, employee_id FROM payouts WHERE id = $1 AND restaurant_id = $2 FOR UPDATE', [id, a.restaurantId],
      )).rows[0];
      if (!p) throw notFound('Payout');
      if (p.status !== 'pending') throw new HttpError(409, 'not_pending', p.status === 'paid' ? 'This payout is already marked as paid.' : 'This payout was cancelled.');
      if (p.rate_missing) throw new HttpError(409, 'rate_missing', 'Set this employee’s salary first so the amount can be calculated.');
      const hasProof = (await tx.query('SELECT 1 FROM payout_proofs WHERE payout_id = $1', [id])).rowCount;
      if (b.method === 'cash' && !photo && !hasProof) throw new HttpError(400, 'photo_required', 'Take a photo of the signed payslip to record a cash payment.');
      if (photo) {
        await tx.query(
          `INSERT INTO payout_proofs (payout_id, restaurant_id, mime, data, uploaded_by_user_id) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (payout_id) DO UPDATE SET mime = EXCLUDED.mime, data = EXCLUDED.data, uploaded_by_user_id = EXCLUDED.uploaded_by_user_id, created_at = now()`,
          [id, a.restaurantId, photo.mime, photo.data, a.userId],
        );
      }
      await tx.query(
        `UPDATE payouts SET status = 'paid', method = $2, paid_at = now(), paid_by_user_id = $3, pay_note = COALESCE($4, pay_note), updated_at = now() WHERE id = $1`,
        [id, b.method, a.userId, b.note ?? null],
      );
      await audit(tx, a.restaurantId, { type: 'user', id: a.userId, ip: req.ip }, 'payroll.paid', { type: 'payout', id }, {
        method: b.method, total_cents: p.total_cents, employee_id: p.employee_id, proof: !!photo || !!hasProof,
      });
      return (await tx.query(`${PAYOUT_SELECT} WHERE p.id = $1`, [id])).rows[0];
    });
  });

  /** Keep pending with a note (e.g. "pay on Friday"). */
  app.post('/api/payouts/:id/note', { preHandler: requireUser(ctx, 'payroll.pay') }, async (req) => {
    const a = req.userAuth!;
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(z.object({ note: z.string().trim().max(300) }), req.body);
    return withTenant(ctx.db, a.restaurantId, async (tx) => {
      const r = await tx.query(`UPDATE payouts SET pay_note = NULLIF($3, ''), updated_at = now() WHERE id = $1 AND restaurant_id = $2 AND status = 'pending'`, [id, a.restaurantId, b.note]);
      if (!r.rowCount) throw new HttpError(409, 'not_pending', 'Only pending payouts can be updated.');
      await audit(tx, a.restaurantId, { type: 'user', id: a.userId, ip: req.ip }, 'payroll.kept_pending', { type: 'payout', id }, { note: b.note });
      return (await tx.query(`${PAYOUT_SELECT} WHERE p.id = $1`, [id])).rows[0];
    });
  });

  /** Add or remove money (bonus, advance, deduction) before paying. */
  app.post('/api/payouts/:id/adjust', { preHandler: requireUser(ctx, 'payroll.pay') }, async (req) => {
    const a = req.userAuth!;
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(z.object({ adjustment: money(-1_000_000, 1_000_000), reason: z.string().trim().min(3, 'Add a short reason').max(200) }), req.body);
    const cents = toCents(b.adjustment);
    return withTenant(ctx.db, a.restaurantId, async (tx) => {
      const p = (await tx.query<{ status: string; base_cents: number; ot_cents: number; adjustment_cents: number }>(
        'SELECT status, base_cents, ot_cents, adjustment_cents FROM payouts WHERE id = $1 AND restaurant_id = $2 FOR UPDATE', [id, a.restaurantId],
      )).rows[0];
      if (!p) throw notFound('Payout');
      if (p.status !== 'pending') throw new HttpError(409, 'not_pending', 'Only pending payouts can be adjusted.');
      if (p.base_cents + p.ot_cents + cents < 0) throw new HttpError(400, 'invalid_adjustment', 'The total cannot go below zero.');
      await tx.query(`UPDATE payouts SET adjustment_cents = $2, adjustment_reason = $3, total_cents = base_cents + ot_cents + $2, updated_at = now() WHERE id = $1`, [id, cents, b.reason]);
      await audit(tx, a.restaurantId, { type: 'user', id: a.userId, ip: req.ip }, 'payroll.adjusted', { type: 'payout', id }, { from_cents: p.adjustment_cents, to_cents: cents, reason: b.reason });
      return (await tx.query(`${PAYOUT_SELECT} WHERE p.id = $1`, [id])).rows[0];
    });
  });

  /** Owner-only undo of a payment recorded by mistake. The proof photo is kept for the record. */
  app.post('/api/payouts/:id/reopen', { preHandler: requireUser(ctx, 'payroll.rates') }, async (req) => {
    const a = req.userAuth!;
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(z.object({ reason: z.string().trim().min(3, 'Add a short reason').max(200) }), req.body);
    return withTenant(ctx.db, a.restaurantId, async (tx) => {
      const p = (await tx.query<{ status: string; method: string; total_cents: number; session_id: string }>('SELECT status, method, total_cents, session_id FROM payouts WHERE id = $1 AND restaurant_id = $2 FOR UPDATE', [id, a.restaurantId])).rows[0];
      if (!p) throw notFound('Payout');
      if (p.status !== 'paid') throw new HttpError(409, 'not_paid', 'Only paid payouts can be reopened.');
      await tx.query(`UPDATE payouts SET status = 'pending', method = NULL, paid_at = NULL, paid_by_user_id = NULL, needs_review = false, review_reason = NULL, updated_at = now() WHERE id = $1`, [id]);
      // Bring amounts up to date with the attendance record now that it is pending again.
      await syncPayoutForSession(tx, await loadRestaurant(tx, a.restaurantId, ctx.cfg.PUBLIC_BASE_URL), p.session_id);
      await audit(tx, a.restaurantId, { type: 'user', id: a.userId, ip: req.ip }, 'payroll.reopened', { type: 'payout', id }, { reason: b.reason, was_method: p.method, was_total_cents: p.total_cents });
      return (await tx.query(`${PAYOUT_SELECT} WHERE p.id = $1`, [id])).rows[0];
    });
  });

  app.post('/api/payouts/:id/resolve-review', { preHandler: requireUser(ctx, 'payroll.pay') }, async (req) => {
    const a = req.userAuth!;
    const { id } = parse(z.object({ id: uuid }), req.params);
    await withTenant(ctx.db, a.restaurantId, async (tx) => {
      const r = await tx.query(`UPDATE payouts SET needs_review = false, review_reason = NULL, updated_at = now() WHERE id = $1 AND restaurant_id = $2 AND needs_review`, [id, a.restaurantId]);
      if (!r.rowCount) throw notFound('Payout needing review');
      await audit(tx, a.restaurantId, { type: 'user', id: a.userId, ip: req.ip }, 'payroll.review_resolved', { type: 'payout', id });
    });
    return { ok: true };
  });

  app.get('/api/reports/payouts.csv', { preHandler: requireUser(ctx, 'payroll.view') }, async (req, reply) => {
    const a = req.userAuth!;
    const q = parse(z.object({ from: ymd, to: ymd }), req.query);
    const csv = await withTenant(ctx.db, a.restaurantId, async (tx) => {
      const r = await loadRestaurant(tx, a.restaurantId, ctx.cfg.PUBLIC_BASE_URL);
      const rows = (await tx.query(`${PAYOUT_SELECT} WHERE p.restaurant_id = $1 AND p.work_date BETWEEN $2 AND $3 AND p.status <> 'void' ORDER BY p.work_date, e.full_name`, [a.restaurantId, q.from, q.to])).rows;
      const rm = (c: number) => (c / 100).toFixed(2);
      const fmt = (d: Date | null) => (d ? formatLocal(d, r.timezone, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '');
      await audit(tx, a.restaurantId, { type: 'user', id: a.userId, ip: req.ip }, 'report.exported', { type: 'report' }, { report: 'payouts', from: q.from, to: q.to });
      return toCsv(
        ['Work date', 'Staff ID', 'Name', 'Worked (h)', 'OT (h)', `Day salary (${r.settings.currency})`, 'Base', 'OT pay', 'Adjustment', 'Adjustment reason', 'Total', 'Status', 'Method', 'Paid at', 'Paid by', 'Proof photo', 'Note'],
        rows.map((x) => [x.work_date, x.staff_id, x.full_name, (x.worked_minutes / 60).toFixed(2), (x.ot_minutes / 60).toFixed(2), rm(x.daily_rate_cents), rm(x.base_cents), rm(x.ot_cents), rm(x.adjustment_cents), x.adjustment_reason, rm(x.total_cents), x.status, x.method, fmt(x.paid_at), x.paid_by, x.has_proof ? 'yes' : 'no', x.pay_note]),
      );
    });
    reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="payouts-${q.from}-to-${q.to}.csv"`);
    return csv;
  });

  // ------------------------------------------------------------------ Leaderboard
  app.get('/api/leaderboard', { preHandler: requireUser(ctx, 'attendance.read') }, async (req) => {
    const a = req.userAuth!;
    const q = parse(z.object({ period: z.enum(['week', 'month', 'last_month', 'custom']).default('week'), from: ymd.optional(), to: ymd.optional(), branch_id: uuid.optional() }), req.query);
    return withTenant(ctx.db, a.restaurantId, async (tx) => {
      const r = await loadRestaurant(tx, a.restaurantId, ctx.cfg.PUBLIC_BASE_URL);
      const today = localDate(new Date(), r.timezone);
      let from: string;
      let to: string = today;
      if (q.period === 'custom') {
        if (!q.from || !q.to || q.from > q.to) throw new HttpError(400, 'invalid_range', 'Choose a valid date range');
        from = q.from;
        to = q.to;
      } else if (q.period === 'month') from = `${today.slice(0, 7)}-01`;
      else if (q.period === 'last_month') {
        to = addDays(`${today.slice(0, 7)}-01`, -1);
        from = `${to.slice(0, 7)}-01`;
      } else from = addDays(today, -6);
      return { period: q.period, ...(await leaderboard(tx, r, from, to, q.branch_id ?? null)) };
    });
  });
}
