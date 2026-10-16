import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { withTenant, type Tx } from '../db.js';
import { audit } from '../audit.js';
import { loadRestaurant, loadShift, loadAssignments, type RestaurantCtx } from '../attendance.js';
import { claimKey, computeDuration, computeLateness, resolveShiftForCheckIn } from '../shifts.js';
import { streamToReply } from '../realtime.js';
import { HttpError, notFound, parse, requireUser, uuid, ymd, type AppCtx } from '../http.js';
import { runAttendance } from './kiosk.js';
import { syncPayoutForSession } from '../payroll.js';

export const EVENT_SELECT = `
  SELECT ev.id, ev.event_type, ev.event_time, ev.device_timestamp, ev.server_received_at, ev.source, ev.verification_status,
         ev.recorded_offline, ev.match_score, ev.exception_flags, ev.note, ev.session_id, ev.review_note, ev.reviewed_at,
         e.id AS employee_id, e.full_name, e.staff_id, (SELECT EXISTS (SELECT 1 FROM employee_photos p WHERE p.employee_id = e.id)) AS has_photo,
         b.name AS branch_name, d.name AS device_name,
         s.scheduled_start, s.is_late, s.late_minutes, s.worked_minutes, s.is_corrected, s.status AS session_status
    FROM attendance_events ev
    JOIN employees e ON e.id = ev.employee_id
    LEFT JOIN branches b ON b.id = ev.branch_id
    LEFT JOIN devices d ON d.id = ev.device_id
    LEFT JOIN attendance_sessions s ON s.id = ev.session_id`;

const SESSION_SELECT = `
  SELECT s.id, s.status, s.employee_id, e.full_name, e.staff_id, s.branch_id, b.name AS branch_name,
         s.check_in_at, s.check_out_at, s.corrected_check_in_at, s.corrected_check_out_at, s.is_corrected,
         COALESCE(s.corrected_check_in_at, s.check_in_at) AS effective_check_in,
         COALESCE(s.corrected_check_out_at, s.check_out_at) AS effective_check_out,
         s.scheduled_start, s.scheduled_end, sh.name AS shift_name, s.late_minutes, s.is_late, s.break_minutes,
         s.worked_minutes, s.overtime_minutes, s.needs_review, s.check_in_event_id, s.check_out_event_id
    FROM attendance_sessions s
    JOIN employees e ON e.id = s.employee_id
    LEFT JOIN branches b ON b.id = s.branch_id
    LEFT JOIN shifts sh ON sh.id = s.shift_id`;

/** Recomputes derived session fields from (possibly corrected) times. Original times are untouched. */
async function recomputeSession(tx: Tx, r: RestaurantCtx, sessionId: string, effIn: Date, effOut: Date | null) {
  const s = (await tx.query('SELECT shift_id, scheduled_start, scheduled_end FROM attendance_sessions WHERE id = $1', [sessionId])).rows[0];
  const shift = await loadShift(tx, s.shift_id);
  const occ = shift && s.scheduled_start ? { shift, start: s.scheduled_start as Date, end: s.scheduled_end as Date, localDate: '' } : null;
  const late = computeLateness(effIn, occ);
  if (effOut) {
    const d = computeDuration(effIn, effOut, shift, occ ? { start: occ.start, end: occ.end } : null, r.settings);
    await tx.query(
      `UPDATE attendance_sessions SET late_minutes = $2, is_late = $3, break_minutes = $4, worked_minutes = $5, overtime_minutes = $6,
              status = CASE WHEN status IN ('open','missing_checkout') THEN 'closed'::session_status ELSE status END, updated_at = now()
        WHERE id = $1`,
      [sessionId, late.lateMinutes, late.isLate, d.breakMinutes, d.workedMinutes, d.overtimeMinutes],
    );
  } else {
    await tx.query('UPDATE attendance_sessions SET late_minutes = $2, is_late = $3, updated_at = now() WHERE id = $1', [sessionId, late.lateMinutes, late.isLate]);
  }
}

async function applyCorrection(tx: Tx, r: RestaurantCtx, c: { id: string; kind: string; session_id: string | null; employee_id: string; new_values: Record<string, string | null> }, userId: string) {
  if (c.kind === 'void_session') {
    if (!c.session_id) throw new HttpError(400, 'invalid_correction', 'session is required');
    await tx.query(`UPDATE attendance_sessions SET status = 'voided', is_corrected = true, needs_review = false, updated_at = now() WHERE id = $1`, [c.session_id]);
    return c.session_id;
  }
  if (c.kind === 'adjust_times') {
    if (!c.session_id) throw new HttpError(400, 'invalid_correction', 'session is required');
    const s = (await tx.query('SELECT check_in_at, check_out_at, corrected_check_in_at, corrected_check_out_at, status FROM attendance_sessions WHERE id = $1 FOR UPDATE', [c.session_id])).rows[0];
    if (!s) throw notFound('Session');
    const effIn: Date = c.new_values.check_in_at ? new Date(c.new_values.check_in_at) : (s.corrected_check_in_at ?? s.check_in_at);
    const effOut: Date | null = c.new_values.check_out_at ? new Date(c.new_values.check_out_at) : (s.corrected_check_out_at ?? s.check_out_at);
    if (effOut && effOut <= effIn) throw new HttpError(400, 'invalid_correction', 'Check-out must be after check-in');
    if (effOut && effOut.getTime() - effIn.getTime() > 36 * 3_600_000) throw new HttpError(400, 'invalid_correction', 'A session cannot be longer than 36 hours');
    await tx.query(
      `UPDATE attendance_sessions SET corrected_check_in_at = $2, corrected_check_out_at = $3, is_corrected = true, needs_review = false, updated_at = now() WHERE id = $1`,
      [c.session_id, c.new_values.check_in_at ? effIn : s.corrected_check_in_at, c.new_values.check_out_at ? effOut : s.corrected_check_out_at],
    );
    await recomputeSession(tx, r, c.session_id, effIn, effOut);
    await tx.query(`UPDATE attendance_exceptions SET status = 'resolved', resolved_at = now(), resolved_by_user_id = $2, resolution_note = 'Corrected' WHERE session_id = $1 AND kind = 'missing_checkout' AND status = 'open'`, [c.session_id, userId]);
    return c.session_id;
  }
  // add_session: creates manual events (source=manual) so the event history stays complete.
  const inAt = new Date(c.new_values.check_in_at!);
  const outAt = c.new_values.check_out_at ? new Date(c.new_values.check_out_at) : null;
  if (!outAt || outAt <= inAt) throw new HttpError(400, 'invalid_correction', 'Check-out must be after check-in');
  const emp = (await tx.query('SELECT branch_id FROM employees WHERE id = $1', [c.employee_id])).rows[0];
  const assignments = await loadAssignments(tx, c.employee_id);
  const claimed = new Set((await tx.query<{ shift_id: string; scheduled_start: Date }>(`SELECT shift_id, scheduled_start FROM attendance_sessions WHERE employee_id = $1 AND shift_id IS NOT NULL AND status <> 'voided'`, [c.employee_id])).rows.map((x) => claimKey(x.shift_id, x.scheduled_start)));
  const occ = resolveShiftForCheckIn(inAt, assignments, r.timezone, r.settings.early_check_in_window_minutes, claimed);
  const late = computeLateness(inAt, occ);
  const d = computeDuration(inAt, outAt, occ?.shift ?? null, occ ? { start: occ.start, end: occ.end } : null, r.settings);
  const inId = randomUUID();
  const outId = randomUUID();
  const sid = (await tx.query<{ id: string }>(
    `INSERT INTO attendance_sessions (restaurant_id, branch_id, employee_id, status, check_in_event_id, check_out_event_id, check_in_at, check_out_at,
            shift_id, scheduled_start, scheduled_end, late_minutes, is_late, break_minutes, worked_minutes, overtime_minutes, is_corrected)
     VALUES ($1,$2,$3,'closed',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,true) RETURNING id`,
    [r.id, emp?.branch_id ?? null, c.employee_id, inId, outId, inAt, outAt, occ?.shift.id ?? null, occ?.start ?? null, occ?.end ?? null, late.lateMinutes, late.isLate, d.breakMinutes, d.workedMinutes, d.overtimeMinutes],
  )).rows[0].id;
  for (const [id, type, at] of [[inId, 'check_in', inAt], [outId, 'check_out', outAt]] as const) {
    await tx.query(
      `INSERT INTO attendance_events (id, restaurant_id, branch_id, employee_id, event_type, event_time, source, verification_status, session_id, exception_flags, note, created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,'manual','verified',$7,'{correction}',$8,$9)`,
      [id, r.id, emp?.branch_id ?? null, c.employee_id, type, at, sid, `Correction ${c.id}`, userId],
    );
  }
  return sid;
}

export function registerAttendanceRoutes(app: FastifyInstance, ctx: AppCtx) {
  app.get('/api/stream', { preHandler: requireUser(ctx, 'attendance.read') }, async (req, reply) => {
    streamToReply(ctx.hub, req.userAuth!.restaurantId, reply);
  });

  app.get('/api/events', { preHandler: requireUser(ctx, 'attendance.read') }, async (req) => {
    const a = req.userAuth!;
    const q = parse(
      z.object({
        from: z.string().datetime({ offset: true }).optional(),
        to: z.string().datetime({ offset: true }).optional(),
        employee_id: uuid.optional(),
        branch_id: uuid.optional(),
        status: z.enum(['verified', 'pending_review', 'rejected']).optional(),
        before: z.string().datetime({ offset: true }).optional(),
        /** Tie-breaker for the cursor: events sharing the boundary timestamp are paged by id. */
        before_id: uuid.optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
        id: uuid.optional(),
      }),
      req.query,
    );
    return withTenant(ctx.db, a.restaurantId, async (tx) => ({
      events: (await tx.query(
        `${EVENT_SELECT}
          WHERE ev.restaurant_id = $1 AND ($2::timestamptz IS NULL OR ev.event_time >= $2) AND ($3::timestamptz IS NULL OR ev.event_time < $3)
            AND ($4::uuid IS NULL OR ev.employee_id = $4) AND ($5::uuid IS NULL OR ev.branch_id = $5)
            AND ($6::verification_status IS NULL OR ev.verification_status = $6)
            AND ($7::timestamptz IS NULL OR (ev.event_time, ev.id) < ($7::timestamptz, COALESCE($10::uuid, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid))) AND ($9::uuid IS NULL OR ev.id = $9)
          ORDER BY ev.event_time DESC, ev.id DESC LIMIT $8`,
        [a.restaurantId, q.from ?? null, q.to ?? null, q.employee_id ?? null, q.branch_id ?? null, q.status ?? null, q.before ?? null, q.limit, q.id ?? null, q.before_id ?? null],
      )).rows,
    }));
  });

  app.get('/api/sessions', { preHandler: requireUser(ctx, 'attendance.read') }, async (req) => {
    const a = req.userAuth!;
    const q = parse(z.object({ from: ymd, to: ymd, employee_id: uuid.optional(), branch_id: uuid.optional(), id: uuid.optional() }), req.query);
    return withTenant(ctx.db, a.restaurantId, async (tx) => {
      const tz = (await tx.query<{ timezone: string }>('SELECT timezone FROM restaurants WHERE id = $1', [a.restaurantId])).rows[0].timezone;
      return {
        sessions: (await tx.query(
          `${SESSION_SELECT}
            WHERE s.restaurant_id = $1 AND (($6::uuid IS NOT NULL AND s.id = $6) OR ($6::uuid IS NULL
              AND COALESCE(s.corrected_check_in_at, s.check_in_at) >= ($2::date)::timestamp AT TIME ZONE $5
              AND COALESCE(s.corrected_check_in_at, s.check_in_at) < ($3::date + 1)::timestamp AT TIME ZONE $5))
              AND ($4::uuid IS NULL OR s.employee_id = $4) AND ($7::uuid IS NULL OR s.branch_id = $7)
            ORDER BY COALESCE(s.corrected_check_in_at, s.check_in_at) DESC LIMIT 5000`,
          [a.restaurantId, q.from, q.to, q.employee_id ?? null, tz, q.id ?? null, q.branch_id ?? null],
        )).rows,
      };
    });
  });

  /** Owner-assisted attendance (e.g. kiosk broken, employee cannot be recognised). */
  app.post('/api/attendance/manual', { preHandler: requireUser(ctx, 'attendance.manual') }, async (req, reply) => {
    const a = req.userAuth!;
    const b = parse(
      z.object({
        event_id: uuid.optional(),
        employee_id: uuid,
        action: z.enum(['check_in', 'check_out']),
        time: z.string().datetime({ offset: true }).optional(),
        note: z.string().trim().min(3, 'Please add a short reason').max(300),
      }),
      req.body,
    );
    const result = await runAttendance(ctx, a.restaurantId, {
      eventId: b.event_id ?? randomUUID(),
      action: b.action,
      method: 'manual',
      deviceId: null,
      branchId: null,
      claimedEmployeeId: b.employee_id,
      manualTime: b.time ? new Date(b.time) : null,
      note: b.note,
      offline: false,
      actor: { type: 'user', id: a.userId, ip: req.ip },
    });
    return reply.status(201).send(result);
  });

  app.post('/api/events/:id/review', { preHandler: requireUser(ctx, 'attendance.review') }, async (req) => {
    const a = req.userAuth!;
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(z.object({ decision: z.enum(['approve', 'reject']), note: z.string().max(300).optional() }), req.body);
    return withTenant(ctx.db, a.restaurantId, async (tx) => {
      const ev = (await tx.query('SELECT id, event_type, session_id, verification_status FROM attendance_events WHERE id = $1 AND restaurant_id = $2 FOR UPDATE', [id, a.restaurantId])).rows[0];
      if (!ev) throw notFound('Event');
      if (ev.verification_status !== 'pending_review') throw new HttpError(409, 'not_pending', 'This event is not awaiting review');
      const status = b.decision === 'approve' ? 'verified' : 'rejected';
      await tx.query('UPDATE attendance_events SET verification_status = $2, reviewed_by_user_id = $3, reviewed_at = now(), review_note = $4 WHERE id = $1', [id, status, a.userId, b.note ?? null]);
      if (ev.session_id) {
        if (b.decision === 'reject' && ev.event_type === 'check_in') {
          await tx.query(`UPDATE attendance_sessions SET status = 'voided', needs_review = false, updated_at = now() WHERE id = $1`, [ev.session_id]);
        } else if (b.decision === 'reject' && ev.event_type === 'check_out') {
          await tx.query(
            `UPDATE attendance_sessions SET status = 'missing_checkout', check_out_at = NULL, check_out_event_id = NULL, worked_minutes = NULL,
                    break_minutes = 0, overtime_minutes = 0, needs_review = true, updated_at = now() WHERE id = $1 AND check_out_event_id = $2`,
            [ev.session_id, id],
          );
        } else {
          await tx.query(
            `UPDATE attendance_sessions SET needs_review = EXISTS (SELECT 1 FROM attendance_events WHERE session_id = $1 AND verification_status = 'pending_review'), updated_at = now() WHERE id = $1`,
            [ev.session_id],
          );
        }
        await syncPayoutForSession(tx, await loadRestaurant(tx, a.restaurantId, ctx.cfg.PUBLIC_BASE_URL), ev.session_id);
      }
      await tx.query(`UPDATE attendance_exceptions SET status = 'resolved', resolved_at = now(), resolved_by_user_id = $2, resolution_note = $3 WHERE event_id = $1 AND status = 'open'`, [id, a.userId, `Event ${status}`]);
      await audit(tx, a.restaurantId, { type: 'user', id: a.userId, ip: req.ip }, `attendance.review_${b.decision}`, { type: 'attendance_event', id }, { note: b.note });
      return { ok: true, verification_status: status };
    });
  });

  app.get('/api/exceptions', { preHandler: requireUser(ctx, 'attendance.read') }, async (req) => {
    const a = req.userAuth!;
    const q = parse(z.object({ status: z.enum(['open', 'resolved', 'all']).default('open'), limit: z.coerce.number().int().min(1).max(500).default(200) }), req.query);
    return withTenant(ctx.db, a.restaurantId, async (tx) => ({
      exceptions: (await tx.query(
        `SELECT x.id, x.kind, x.severity, x.status, x.details, x.created_at, x.resolved_at, x.resolution_note, x.session_id, x.event_id,
                x.employee_id, e.full_name, e.staff_id, d.name AS device_name, x.device_id
           FROM attendance_exceptions x LEFT JOIN employees e ON e.id = x.employee_id LEFT JOIN devices d ON d.id = x.device_id
          WHERE x.restaurant_id = $1 AND ($2 = 'all' OR x.status = $2) ORDER BY x.created_at DESC LIMIT $3`,
        [a.restaurantId, q.status, q.limit],
      )).rows,
    }));
  });

  app.post('/api/exceptions/:id/resolve', { preHandler: requireUser(ctx, 'attendance.review') }, async (req) => {
    const a = req.userAuth!;
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(z.object({ note: z.string().max(300).optional() }), req.body);
    await withTenant(ctx.db, a.restaurantId, async (tx) => {
      const r = await tx.query(`UPDATE attendance_exceptions SET status = 'resolved', resolved_at = now(), resolved_by_user_id = $3, resolution_note = $4 WHERE id = $1 AND restaurant_id = $2 AND status = 'open'`, [id, a.restaurantId, a.userId, b.note ?? null]);
      if (!r.rowCount) throw notFound('Open alert');
      await audit(tx, a.restaurantId, { type: 'user', id: a.userId, ip: req.ip }, 'exception.resolved', { type: 'exception', id }, { note: b.note });
    });
    return { ok: true };
  });

  // --- Corrections: requested by any role, approved by owner/manager, always auditable.
  app.get('/api/corrections', { preHandler: requireUser(ctx, 'attendance.read') }, async (req) => {
    const a = req.userAuth!;
    const q = parse(z.object({ status: z.enum(['requested', 'approved', 'rejected', 'all']).default('all') }), req.query);
    return withTenant(ctx.db, a.restaurantId, async (tx) => ({
      corrections: (await tx.query(
        `SELECT c.*, e.full_name, e.staff_id, u1.full_name AS requested_by, u2.full_name AS decided_by
           FROM attendance_corrections c JOIN employees e ON e.id = c.employee_id
           LEFT JOIN users u1 ON u1.id = c.requested_by_user_id LEFT JOIN users u2 ON u2.id = c.decided_by_user_id
          WHERE c.restaurant_id = $1 AND ($2 = 'all' OR c.status::text = $2) ORDER BY c.created_at DESC LIMIT 300`,
        [a.restaurantId, q.status],
      )).rows,
    }));
  });

  app.post('/api/corrections', { preHandler: requireUser(ctx, 'corrections.request') }, async (req, reply) => {
    const a = req.userAuth!;
    const iso = z.string().datetime({ offset: true });
    const b = parse(
      z.object({
        kind: z.enum(['adjust_times', 'add_session', 'void_session']),
        session_id: uuid.optional(),
        employee_id: uuid.optional(),
        check_in_at: iso.optional(),
        check_out_at: iso.optional(),
        reason: z.string().trim().min(3).max(500),
        apply_now: z.boolean().default(false),
      }),
      req.body,
    );
    const canApprove = a.role === 'owner' || a.role === 'manager';
    return withTenant(ctx.db, a.restaurantId, async (tx) => {
      const r = await loadRestaurant(tx, a.restaurantId, ctx.cfg.PUBLIC_BASE_URL);
      let employeeId = b.employee_id;
      let original: Record<string, unknown> = {};
      if (b.kind !== 'add_session') {
        if (!b.session_id) throw new HttpError(400, 'invalid_correction', 'session_id is required');
        const s = (await tx.query(`SELECT employee_id, check_in_at, check_out_at, corrected_check_in_at, corrected_check_out_at, status FROM attendance_sessions WHERE id = $1 AND restaurant_id = $2`, [b.session_id, a.restaurantId])).rows[0];
        if (!s) throw notFound('Session');
        employeeId = s.employee_id;
        original = s;
        if (b.kind === 'adjust_times' && !b.check_in_at && !b.check_out_at) throw new HttpError(400, 'invalid_correction', 'Provide a corrected check-in or check-out time');
      } else {
        if (!employeeId || !b.check_in_at || !b.check_out_at) throw new HttpError(400, 'invalid_correction', 'employee_id, check_in_at and check_out_at are required');
        const e = await tx.query('SELECT 1 FROM employees WHERE id = $1 AND restaurant_id = $2', [employeeId, a.restaurantId]);
        if (!e.rowCount) throw notFound('Employee');
      }
      if (b.check_in_at && new Date(b.check_in_at) > new Date()) throw new HttpError(400, 'invalid_correction', 'Times cannot be in the future');
      if (b.check_out_at && new Date(b.check_out_at).getTime() > Date.now() + 60_000) throw new HttpError(400, 'invalid_correction', 'Times cannot be in the future');
      const newValues = { check_in_at: b.check_in_at ?? null, check_out_at: b.check_out_at ?? null };
      const c = (await tx.query(
        `INSERT INTO attendance_corrections (restaurant_id, session_id, employee_id, kind, original_values, new_values, reason, requested_by_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, kind, session_id, employee_id, new_values`,
        [a.restaurantId, b.session_id ?? null, employeeId, b.kind, original, newValues, b.reason, a.userId],
      )).rows[0];
      await audit(tx, a.restaurantId, { type: 'user', id: a.userId, ip: req.ip }, 'correction.requested', { type: 'correction', id: c.id }, { kind: b.kind, session_id: b.session_id });
      if (b.apply_now && canApprove) {
        const sid = await applyCorrection(tx, r, c, a.userId);
        await syncPayoutForSession(tx, r, sid);
        await tx.query(`UPDATE attendance_corrections SET status = 'approved', decided_by_user_id = $2, decided_at = now(), session_id = COALESCE(session_id, $3) WHERE id = $1`, [c.id, a.userId, sid]);
        await audit(tx, a.restaurantId, { type: 'user', id: a.userId, ip: req.ip }, 'correction.approved', { type: 'correction', id: c.id }, { session_id: sid });
      }
      // Body is returned (not sent) so Fastify replies only after the transaction has committed.
      reply.status(201);
      return { id: c.id, status: b.apply_now && canApprove ? 'approved' : 'requested' };
    });
  });

  app.post('/api/corrections/:id/:decision', { preHandler: requireUser(ctx, 'corrections.approve') }, async (req) => {
    const a = req.userAuth!;
    const { id, decision } = parse(z.object({ id: uuid, decision: z.enum(['approve', 'reject']) }), req.params);
    const b = parse(z.object({ note: z.string().max(300).optional() }), req.body);
    return withTenant(ctx.db, a.restaurantId, async (tx) => {
      const r = await loadRestaurant(tx, a.restaurantId, ctx.cfg.PUBLIC_BASE_URL);
      const c = (await tx.query('SELECT id, kind, session_id, employee_id, new_values, status FROM attendance_corrections WHERE id = $1 AND restaurant_id = $2 FOR UPDATE', [id, a.restaurantId])).rows[0];
      if (!c) throw notFound('Correction');
      if (c.status !== 'requested') throw new HttpError(409, 'already_decided', 'This correction was already decided');
      let sid = c.session_id;
      if (decision === 'approve') {
        sid = await applyCorrection(tx, r, c, a.userId);
        await syncPayoutForSession(tx, r, sid);
      }
      await tx.query(`UPDATE attendance_corrections SET status = $2, decided_by_user_id = $3, decided_at = now(), decision_note = $4, session_id = COALESCE(session_id, $5) WHERE id = $1`, [id, decision === 'approve' ? 'approved' : 'rejected', a.userId, b.note ?? null, sid]);
      await audit(tx, a.restaurantId, { type: 'user', id: a.userId, ip: req.ip }, `correction.${decision}d`, { type: 'correction', id }, { note: b.note });
      return { ok: true };
    });
  });
}
