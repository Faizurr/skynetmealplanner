import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTenant } from '../db.js';
import { hashSecret, newPairingCode, sha256 } from '../crypto.js';
import { audit } from '../audit.js';
import { isValidTimeZone } from '../time.js';
import { restaurantSettingsSchema, resolveSettings } from '../settings.js';
import { enqueueNotification, renderEmail } from '../notifications.js';
import { HttpError, hhmm, notFound, parse, requireUser, uuid, type AppCtx } from '../http.js';
import { randomBytes } from 'node:crypto';

export function registerAdminRoutes(app: FastifyInstance, ctx: AppCtx) {
  // ---------------------------------------------------------------- Branches
  app.get('/api/branches', { preHandler: requireUser(ctx, 'attendance.read') }, async (req) => {
    const a = req.userAuth!;
    return withTenant(ctx.db, a.restaurantId, async (tx) => ({
      branches: (await tx.query(
        `SELECT b.*, (SELECT count(*)::int FROM employees e WHERE e.branch_id = b.id AND e.status = 'active') AS employee_count,
                (SELECT count(*)::int FROM devices d WHERE d.branch_id = b.id AND d.status = 'active') AS device_count
           FROM branches b WHERE b.restaurant_id = $1 ORDER BY b.created_at`,
        [a.restaurantId],
      )).rows,
    }));
  });

  const branchBody = z.object({ name: z.string().trim().min(1).max(120), address: z.string().trim().max(300).nullable().optional(), timezone: z.string().refine(isValidTimeZone).nullable().optional(), active: z.boolean().optional() });

  app.post('/api/branches', { preHandler: requireUser(ctx, 'settings.manage') }, async (req, reply) => {
    const a = req.userAuth!;
    const b = parse(branchBody, req.body);
    const branch = await withTenant(ctx.db, a.restaurantId, async (tx) => {
      const r = (await tx.query('INSERT INTO branches (restaurant_id, name, address, timezone) VALUES ($1,$2,$3,$4) RETURNING *', [a.restaurantId, b.name, b.address ?? null, b.timezone ?? null])).rows[0];
      await audit(tx, a.restaurantId, { type: 'user', id: a.userId, ip: req.ip }, 'branch.created', { type: 'branch', id: r.id }, { name: b.name });
      return r;
    });
    return reply.status(201).send({ branch });
  });

  app.patch('/api/branches/:id', { preHandler: requireUser(ctx, 'settings.manage') }, async (req) => {
    const a = req.userAuth!;
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(branchBody.partial(), req.body);
    return withTenant(ctx.db, a.restaurantId, async (tx) => {
      const r = await tx.query(
        `UPDATE branches SET name = COALESCE($3, name), address = CASE WHEN $4::boolean THEN $5 ELSE address END, active = COALESCE($6, active)
          WHERE id = $1 AND restaurant_id = $2 RETURNING *`,
        [id, a.restaurantId, b.name ?? null, b.address !== undefined, b.address ?? null, b.active ?? null],
      );
      if (!r.rowCount) throw notFound('Branch');
      await audit(tx, a.restaurantId, { type: 'user', id: a.userId, ip: req.ip }, 'branch.updated', { type: 'branch', id });
      return { branch: r.rows[0] };
    });
  });

  // ---------------------------------------------------------------- Shifts
  const shiftBody = z.object({
    name: z.string().trim().min(1).max(80),
    branch_id: uuid.nullable().optional(),
    start_time: hhmm,
    end_time: hhmm,
    days_of_week: z.array(z.number().int().min(1).max(7)).min(1).max(7),
    grace_minutes: z.number().int().min(0).max(240).default(5),
    unpaid_break_minutes: z.number().int().min(0).max(480).default(0),
    break_applies_after_minutes: z.number().int().min(0).max(1440).default(360),
    overtime_after_minutes: z.number().int().min(0).max(1440).nullable().optional(),
    active: z.boolean().default(true),
  });

  app.get('/api/shifts', { preHandler: requireUser(ctx, 'attendance.read') }, async (req) => {
    const a = req.userAuth!;
    return withTenant(ctx.db, a.restaurantId, async (tx) => ({
      shifts: (await tx.query(
        `SELECT s.id, s.name, s.branch_id, to_char(s.start_time, 'HH24:MI') AS start_time, to_char(s.end_time, 'HH24:MI') AS end_time,
                s.days_of_week, s.grace_minutes, s.unpaid_break_minutes, s.break_applies_after_minutes, s.overtime_after_minutes, s.active,
                (s.end_time <= s.start_time) AS overnight,
                (SELECT count(DISTINCT a.employee_id)::int FROM shift_assignments a WHERE a.shift_id = s.id AND (a.effective_to IS NULL OR a.effective_to >= CURRENT_DATE)) AS employee_count
           FROM shifts s WHERE s.restaurant_id = $1 ORDER BY s.active DESC, s.start_time`,
        [a.restaurantId],
      )).rows,
    }));
  });

  app.post('/api/shifts', { preHandler: requireUser(ctx, 'shifts.write') }, async (req, reply) => {
    const a = req.userAuth!;
    const b = parse(shiftBody, req.body);
    const shift = await withTenant(ctx.db, a.restaurantId, async (tx) => {
      const r = (await tx.query(
        `INSERT INTO shifts (restaurant_id, branch_id, name, start_time, end_time, days_of_week, grace_minutes, unpaid_break_minutes, break_applies_after_minutes, overtime_after_minutes, active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [a.restaurantId, b.branch_id ?? null, b.name, b.start_time, b.end_time, [...new Set(b.days_of_week)].sort(), b.grace_minutes, b.unpaid_break_minutes, b.break_applies_after_minutes, b.overtime_after_minutes ?? null, b.active],
      )).rows[0];
      await audit(tx, a.restaurantId, { type: 'user', id: a.userId, ip: req.ip }, 'shift.created', { type: 'shift', id: r.id }, b);
      return r;
    });
    return reply.status(201).send({ shift });
  });

  app.put('/api/shifts/:id', { preHandler: requireUser(ctx, 'shifts.write') }, async (req) => {
    const a = req.userAuth!;
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(shiftBody, req.body);
    return withTenant(ctx.db, a.restaurantId, async (tx) => {
      // Past sessions keep their computed values (scheduled times are copied onto each session).
      const r = await tx.query(
        `UPDATE shifts SET branch_id = $3, name = $4, start_time = $5, end_time = $6, days_of_week = $7, grace_minutes = $8,
                unpaid_break_minutes = $9, break_applies_after_minutes = $10, overtime_after_minutes = $11, active = $12
          WHERE id = $1 AND restaurant_id = $2`,
        [id, a.restaurantId, b.branch_id ?? null, b.name, b.start_time, b.end_time, [...new Set(b.days_of_week)].sort(), b.grace_minutes, b.unpaid_break_minutes, b.break_applies_after_minutes, b.overtime_after_minutes ?? null, b.active],
      );
      if (!r.rowCount) throw notFound('Shift');
      await audit(tx, a.restaurantId, { type: 'user', id: a.userId, ip: req.ip }, 'shift.updated', { type: 'shift', id }, b);
      return { ok: true };
    });
  });

  // ---------------------------------------------------------------- Devices
  app.get('/api/devices', { preHandler: requireUser(ctx, 'attendance.read') }, async (req) => {
    const a = req.userAuth!;
    return withTenant(ctx.db, a.restaurantId, async (tx) => ({
      offline_after_minutes: ctx.cfg.DEVICE_OFFLINE_MINUTES,
      devices: (await tx.query(
        `SELECT d.id, d.name, d.status, d.branch_id, b.name AS branch_name, d.app_version, d.device_model, d.last_seen_at, d.last_sync_at,
                d.pending_queue_count, d.last_error, d.created_at, d.paired_at, d.revoked_at, d.pairing_expires_at,
                (d.status = 'active' AND d.last_seen_at > now() - make_interval(mins => $2)) AS online
           FROM devices d LEFT JOIN branches b ON b.id = d.branch_id WHERE d.restaurant_id = $1 ORDER BY d.status, d.created_at`,
        [a.restaurantId, ctx.cfg.DEVICE_OFFLINE_MINUTES],
      )).rows,
    }));
  });

  app.post('/api/devices', { preHandler: requireUser(ctx, 'devices.manage') }, async (req, reply) => {
    const a = req.userAuth!;
    const b = parse(z.object({ name: z.string().trim().min(1).max(80), branch_id: uuid.nullable().optional() }), req.body);
    const code = newPairingCode();
    const device = await withTenant(ctx.db, a.restaurantId, async (tx) => {
      const r = (await tx.query(
        `INSERT INTO devices (restaurant_id, branch_id, name, pairing_code_hash, pairing_expires_at) VALUES ($1,$2,$3,$4, now() + interval '15 minutes') RETURNING id, pairing_expires_at`,
        [a.restaurantId, b.branch_id ?? null, b.name, sha256(code)],
      )).rows[0];
      await audit(tx, a.restaurantId, { type: 'user', id: a.userId, ip: req.ip }, 'device.created', { type: 'device', id: r.id }, { name: b.name });
      return r;
    });
    return reply.status(201).send({ device_id: device.id, pairing_code: code, expires_at: device.pairing_expires_at, server_url: ctx.cfg.PUBLIC_BASE_URL });
  });

  app.post('/api/devices/:id/pairing-code', { preHandler: requireUser(ctx, 'devices.manage') }, async (req) => {
    const a = req.userAuth!;
    const { id } = parse(z.object({ id: uuid }), req.params);
    const code = newPairingCode();
    return withTenant(ctx.db, a.restaurantId, async (tx) => {
      // Re-pairing invalidates the old device token.
      const r = await tx.query(
        `UPDATE devices SET pairing_code_hash = $3, pairing_expires_at = now() + interval '15 minutes', token_hash = NULL, status = 'pending', revoked_at = NULL
          WHERE id = $1 AND restaurant_id = $2 RETURNING pairing_expires_at`,
        [id, a.restaurantId, sha256(code)],
      );
      if (!r.rowCount) throw notFound('Device');
      await audit(tx, a.restaurantId, { type: 'user', id: a.userId, ip: req.ip }, 'device.pairing_code_created', { type: 'device', id });
      return { pairing_code: code, expires_at: r.rows[0].pairing_expires_at, server_url: ctx.cfg.PUBLIC_BASE_URL };
    });
  });

  app.patch('/api/devices/:id', { preHandler: requireUser(ctx, 'devices.manage') }, async (req) => {
    const a = req.userAuth!;
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(z.object({ name: z.string().trim().min(1).max(80).optional(), branch_id: uuid.nullable().optional() }), req.body);
    return withTenant(ctx.db, a.restaurantId, async (tx) => {
      const r = await tx.query(
        `UPDATE devices SET name = COALESCE($3, name), branch_id = CASE WHEN $4::boolean THEN $5 ELSE branch_id END WHERE id = $1 AND restaurant_id = $2`,
        [id, a.restaurantId, b.name ?? null, b.branch_id !== undefined, b.branch_id ?? null],
      );
      if (!r.rowCount) throw notFound('Device');
      await audit(tx, a.restaurantId, { type: 'user', id: a.userId, ip: req.ip }, 'device.updated', { type: 'device', id }, b);
      return { ok: true };
    });
  });

  app.post('/api/devices/:id/revoke', { preHandler: requireUser(ctx, 'devices.manage') }, async (req) => {
    const a = req.userAuth!;
    const { id } = parse(z.object({ id: uuid }), req.params);
    await withTenant(ctx.db, a.restaurantId, async (tx) => {
      const r = await tx.query(`UPDATE devices SET status = 'revoked', token_hash = NULL, pairing_code_hash = NULL, revoked_at = now() WHERE id = $1 AND restaurant_id = $2`, [id, a.restaurantId]);
      if (!r.rowCount) throw notFound('Device');
      await tx.query(`UPDATE user_sessions SET revoked_at = now() WHERE device_id = $1 AND revoked_at IS NULL`, [id]);
      await audit(tx, a.restaurantId, { type: 'user', id: a.userId, ip: req.ip }, 'device.revoked', { type: 'device', id });
    });
    return { ok: true };
  });

  // ---------------------------------------------------------------- Restaurant settings
  app.get('/api/settings', { preHandler: requireUser(ctx, 'attendance.read') }, async (req) => {
    const a = req.userAuth!;
    return withTenant(ctx.db, a.restaurantId, async (tx) => {
      const r = (await tx.query('SELECT id, name, timezone, settings, created_at FROM restaurants WHERE id = $1', [a.restaurantId])).rows[0];
      return { restaurant: { id: r.id, name: r.name, timezone: r.timezone, created_at: r.created_at }, settings: resolveSettings(r.settings) };
    });
  });

  app.put('/api/settings', { preHandler: requireUser(ctx, 'settings.manage') }, async (req) => {
    const a = req.userAuth!;
    const b = parse(
      z.object({
        name: z.string().trim().min(1).max(120).optional(),
        timezone: z.string().refine(isValidTimeZone, 'Unknown time zone').optional(),
        settings: restaurantSettingsSchema.partial().optional(),
      }),
      req.body,
    );
    return withTenant(ctx.db, a.restaurantId, async (tx) => {
      const cur = (await tx.query('SELECT settings FROM restaurants WHERE id = $1 FOR UPDATE', [a.restaurantId])).rows[0];
      const merged = restaurantSettingsSchema.parse({ ...resolveSettings(cur.settings), ...(b.settings ?? {}) });
      await tx.query('UPDATE restaurants SET name = COALESCE($2, name), timezone = COALESCE($3, timezone), settings = $4 WHERE id = $1', [a.restaurantId, b.name ?? null, b.timezone ?? null, merged]);
      await audit(tx, a.restaurantId, { type: 'user', id: a.userId, ip: req.ip }, 'settings.updated', { type: 'restaurant', id: a.restaurantId }, { changed: { ...b.settings, name: b.name, timezone: b.timezone } });
      return { settings: merged };
    });
  });

  // ---------------------------------------------------------------- Notifications
  app.get('/api/notifications/settings', { preHandler: requireUser(ctx, 'attendance.read') }, async (req) => {
    const a = req.userAuth!;
    return withTenant(ctx.db, a.restaurantId, async (tx) => {
      const r = await tx.query(
        `SELECT emails, on_check_in, on_check_out, important_only, late_arrival, missing_checkout, unknown_face, suspicious_events,
                device_offline, sync_failure, daily_summary, to_char(daily_summary_time, 'HH24:MI') AS daily_summary_time,
                to_char(quiet_hours_start, 'HH24:MI') AS quiet_hours_start, to_char(quiet_hours_end, 'HH24:MI') AS quiet_hours_end, include_staff_id
           FROM notification_settings WHERE restaurant_id = $1`,
        [a.restaurantId],
      );
      return { settings: r.rows[0] ?? null, transport: ctx.mailer?.name ?? 'disabled' };
    });
  });

  app.put('/api/notifications/settings', { preHandler: requireUser(ctx, 'notifications.manage') }, async (req) => {
    const a = req.userAuth!;
    const b = parse(
      z.object({
        emails: z.array(z.string().trim().toLowerCase().email()).max(10),
        on_check_in: z.boolean(), on_check_out: z.boolean(), important_only: z.boolean(), late_arrival: z.boolean(),
        missing_checkout: z.boolean(), unknown_face: z.boolean(), suspicious_events: z.boolean(), device_offline: z.boolean(),
        sync_failure: z.boolean(), daily_summary: z.boolean(), daily_summary_time: hhmm,
        quiet_hours_start: hhmm.nullable(), quiet_hours_end: hhmm.nullable(), include_staff_id: z.boolean(),
      }),
      req.body,
    );
    await withTenant(ctx.db, a.restaurantId, async (tx) => {
      await tx.query(
        `INSERT INTO notification_settings (restaurant_id, emails, on_check_in, on_check_out, important_only, late_arrival, missing_checkout, unknown_face,
                suspicious_events, device_offline, sync_failure, daily_summary, daily_summary_time, quiet_hours_start, quiet_hours_end, include_staff_id, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, now())
         ON CONFLICT (restaurant_id) DO UPDATE SET emails = EXCLUDED.emails, on_check_in = EXCLUDED.on_check_in, on_check_out = EXCLUDED.on_check_out,
           important_only = EXCLUDED.important_only, late_arrival = EXCLUDED.late_arrival, missing_checkout = EXCLUDED.missing_checkout,
           unknown_face = EXCLUDED.unknown_face, suspicious_events = EXCLUDED.suspicious_events, device_offline = EXCLUDED.device_offline,
           sync_failure = EXCLUDED.sync_failure, daily_summary = EXCLUDED.daily_summary, daily_summary_time = EXCLUDED.daily_summary_time,
           quiet_hours_start = EXCLUDED.quiet_hours_start, quiet_hours_end = EXCLUDED.quiet_hours_end, include_staff_id = EXCLUDED.include_staff_id, updated_at = now()`,
        [a.restaurantId, [...new Set(b.emails)], b.on_check_in, b.on_check_out, b.important_only, b.late_arrival, b.missing_checkout, b.unknown_face,
          b.suspicious_events, b.device_offline, b.sync_failure, b.daily_summary, b.daily_summary_time, b.quiet_hours_start, b.quiet_hours_end, b.include_staff_id],
      );
      await audit(tx, a.restaurantId, { type: 'user', id: a.userId, ip: req.ip }, 'notifications.updated', { type: 'restaurant', id: a.restaurantId }, { emails: b.emails.length });
    });
    return { ok: true };
  });

  app.post('/api/notifications/test', { preHandler: requireUser(ctx, 'notifications.manage'), config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req) => {
    const a = req.userAuth!;
    return withTenant(ctx.db, a.restaurantId, async (tx) => {
      const r = (await tx.query<{ name: string; timezone: string }>('SELECT name, timezone FROM restaurants WHERE id = $1', [a.restaurantId])).rows[0];
      const key = `test:${Date.now()}:${randomBytes(4).toString('hex')}`;
      const res = await enqueueNotification(tx, a.restaurantId, r.timezone, 'test', key, () =>
        renderEmail({
          restaurantName: r.name,
          heading: 'Test email from your attendance system',
          intro: 'If you can read this, email notifications are working.',
          rows: [['Requested by', a.fullName], ['Sent at', new Date().toISOString()]],
          link: { href: `${ctx.cfg.PUBLIC_BASE_URL}/#/settings/notifications`, label: 'Notification settings' },
        }),
      );
      if (res === 'disabled') throw new HttpError(400, 'no_recipients', 'Add at least one notification email address first');
      const id = (await tx.query('SELECT id FROM notification_outbox WHERE restaurant_id = $1 AND dedupe_key = $2', [a.restaurantId, key])).rows[0].id;
      return { id, status: 'queued', transport: ctx.mailer?.name ?? 'disabled' };
    });
  });

  app.get('/api/notifications/deliveries', { preHandler: requireUser(ctx, 'notifications.manage') }, async (req) => {
    const a = req.userAuth!;
    const q = parse(z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), id: uuid.optional() }), req.query);
    return withTenant(ctx.db, a.restaurantId, async (tx) => ({
      deliveries: (await tx.query(
        `SELECT id, kind, subject, to_addresses, status, attempts, last_error, created_at, sent_at, next_attempt_at, not_before
           FROM notification_outbox WHERE restaurant_id = $1 AND ($3::uuid IS NULL OR id = $3) ORDER BY created_at DESC LIMIT $2`,
        [a.restaurantId, q.limit, q.id ?? null],
      )).rows,
    }));
  });

  app.post('/api/notifications/deliveries/:id/retry', { preHandler: requireUser(ctx, 'notifications.manage') }, async (req) => {
    const a = req.userAuth!;
    const { id } = parse(z.object({ id: uuid }), req.params);
    await withTenant(ctx.db, a.restaurantId, async (tx) => {
      const r = await tx.query(`UPDATE notification_outbox SET status = 'queued', next_attempt_at = now(), max_attempts = attempts + 3 WHERE id = $1 AND restaurant_id = $2 AND status IN ('failed','suppressed')`, [id, a.restaurantId]);
      if (!r.rowCount) throw new HttpError(409, 'not_retryable', 'Only failed deliveries can be retried');
    });
    return { ok: true };
  });

  // ---------------------------------------------------------------- Team (owner only)
  app.get('/api/team', { preHandler: requireUser(ctx, 'team.manage') }, async (req) => {
    const a = req.userAuth!;
    const r = await ctx.db.query(
      `SELECT u.id, u.email, u.full_name, m.role, u.last_login_at, u.disabled, m.created_at
         FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.restaurant_id = $1 ORDER BY m.created_at`,
      [a.restaurantId],
    );
    return { members: r.rows };
  });

  app.post('/api/team', { preHandler: requireUser(ctx, 'team.manage') }, async (req, reply) => {
    const a = req.userAuth!;
    const b = parse(z.object({ email: z.string().trim().toLowerCase().email(), full_name: z.string().trim().min(1).max(120), role: z.enum(['owner', 'manager', 'attendance_admin']) }), req.body);
    let tempPassword: string | null = null;
    let userId: string;
    const existing = (await ctx.db.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [b.email])).rows[0];
    if (existing) userId = existing.id;
    else {
      tempPassword = randomBytes(9).toString('base64url');
      userId = (await ctx.db.query<{ id: string }>('INSERT INTO users (email, password_hash, full_name, must_change_password) VALUES ($1,$2,$3,true) RETURNING id', [b.email, await hashSecret(tempPassword), b.full_name])).rows[0].id;
    }
    await ctx.db.query('INSERT INTO memberships (user_id, restaurant_id, role) VALUES ($1,$2,$3)', [userId, a.restaurantId, b.role]).catch((e) => {
      if (e.code === '23505') throw new HttpError(409, 'already_member', 'This person is already on your team');
      throw e;
    });
    await withTenant(ctx.db, a.restaurantId, (tx) => audit(tx, a.restaurantId, { type: 'user', id: a.userId, ip: req.ip }, 'team.member_added', { type: 'user', id: userId }, { role: b.role }));
    // The temporary password is shown once to the owner, who shares it securely; it must be changed at first sign-in.
    return reply.status(201).send({ user_id: userId, temporary_password: tempPassword });
  });

  app.patch('/api/team/:userId', { preHandler: requireUser(ctx, 'team.manage') }, async (req) => {
    const a = req.userAuth!;
    const { userId } = parse(z.object({ userId: uuid }), req.params);
    const b = parse(z.object({ role: z.enum(['owner', 'manager', 'attendance_admin']) }), req.body);
    if (userId === a.userId && b.role !== 'owner') {
      const owners = (await ctx.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM memberships WHERE restaurant_id = $1 AND role = 'owner'`, [a.restaurantId])).rows[0].n;
      if (owners <= 1) throw new HttpError(409, 'last_owner', 'A restaurant must keep at least one owner');
    }
    const r = await ctx.db.query('UPDATE memberships SET role = $3 WHERE user_id = $1 AND restaurant_id = $2', [userId, a.restaurantId, b.role]);
    if (!r.rowCount) throw notFound('Team member');
    await withTenant(ctx.db, a.restaurantId, (tx) => audit(tx, a.restaurantId, { type: 'user', id: a.userId, ip: req.ip }, 'team.role_changed', { type: 'user', id: userId }, { role: b.role }));
    return { ok: true };
  });

  app.delete('/api/team/:userId', { preHandler: requireUser(ctx, 'team.manage') }, async (req) => {
    const a = req.userAuth!;
    const { userId } = parse(z.object({ userId: uuid }), req.params);
    const target = (await ctx.db.query<{ role: string }>('SELECT role FROM memberships WHERE user_id = $1 AND restaurant_id = $2', [userId, a.restaurantId])).rows[0];
    if (!target) throw notFound('Team member');
    if (target.role === 'owner') {
      const owners = (await ctx.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM memberships WHERE restaurant_id = $1 AND role = 'owner'`, [a.restaurantId])).rows[0].n;
      if (owners <= 1) throw new HttpError(409, 'last_owner', 'A restaurant must keep at least one owner');
    }
    await ctx.db.query('DELETE FROM memberships WHERE user_id = $1 AND restaurant_id = $2', [userId, a.restaurantId]);
    await ctx.db.query('UPDATE user_sessions SET revoked_at = now() WHERE user_id = $1 AND restaurant_id = $2 AND revoked_at IS NULL', [userId, a.restaurantId]);
    await withTenant(ctx.db, a.restaurantId, (tx) => audit(tx, a.restaurantId, { type: 'user', id: a.userId, ip: req.ip }, 'team.member_removed', { type: 'user', id: userId }));
    return { ok: true };
  });

  // ---------------------------------------------------------------- Audit log
  app.get('/api/audit', { preHandler: requireUser(ctx, 'audit.read') }, async (req) => {
    const a = req.userAuth!;
    const q = parse(z.object({ limit: z.coerce.number().int().min(1).max(500).default(100), before: z.coerce.number().int().optional(), entity_id: uuid.optional() }), req.query);
    return withTenant(ctx.db, a.restaurantId, async (tx) => ({
      entries: (await tx.query(
        `SELECT l.id, l.actor_type, l.actor_id, l.action, l.entity_type, l.entity_id, l.details, l.created_at,
                COALESCE(u.full_name, d.name, 'System') AS actor_name
           FROM audit_logs l LEFT JOIN users u ON l.actor_type = 'user' AND u.id = l.actor_id
           LEFT JOIN devices d ON l.actor_type = 'device' AND d.id = l.actor_id
          WHERE l.restaurant_id = $1 AND ($3::bigint IS NULL OR l.id < $3) AND ($4::uuid IS NULL OR l.entity_id = $4)
          ORDER BY l.id DESC LIMIT $2`,
        [a.restaurantId, q.limit, q.before ?? null, q.entity_id ?? null],
      )).rows,
    }));
  });
}
