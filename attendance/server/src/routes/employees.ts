import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTenant, type Tx } from '../db.js';
import { hashSecret } from '../crypto.js';
import { audit } from '../audit.js';
import { HttpError, notFound, parse, requireUser, uuid, ymd, type AppCtx } from '../http.js';

const employeeFields = {
  full_name: z.string().trim().min(1).max(120),
  preferred_name: z.string().trim().max(60).nullable().optional(),
  staff_id: z.string().trim().regex(/^[A-Za-z0-9._-]{1,32}$/, 'Letters, numbers, dot, dash or underscore (max 32)'),
  job_title: z.string().trim().max(80).nullable().optional(),
  department: z.string().trim().max(80).nullable().optional(),
  email: z.string().trim().email().nullable().optional().or(z.literal('').transform(() => null)),
  branch_id: uuid.nullable().optional(),
  shift_ids: z.array(uuid).max(10).optional(),
};

const EMP_SELECT = `
  SELECT e.id, e.staff_id, e.full_name, e.preferred_name, e.job_title, e.department, e.email, e.status, e.branch_id,
         b.name AS branch_name, e.created_at, e.updated_at, e.deactivated_at, (e.pin_hash IS NOT NULL) AS has_pin,
         (SELECT row_to_json(f) FROM (SELECT id, status, created_at, confirmed_at, template_count, consent_method
             FROM face_enrollments WHERE employee_id = e.id AND status IN ('active','pending_confirmation') LIMIT 1) f) AS enrollment,
         EXISTS (SELECT 1 FROM employee_photos p WHERE p.employee_id = e.id) AS has_photo,
         COALESCE((SELECT json_agg(json_build_object('id', s.id, 'name', s.name, 'start_time', s.start_time, 'end_time', s.end_time)
             ORDER BY s.start_time)
             FROM shift_assignments a JOIN shifts s ON s.id = a.shift_id
            WHERE a.employee_id = e.id AND (a.effective_to IS NULL OR a.effective_to >= CURRENT_DATE)), '[]') AS shifts,
         (SELECT row_to_json(x) FROM (SELECT id, check_in_at FROM attendance_sessions WHERE employee_id = e.id AND status = 'open') x) AS open_session
    FROM employees e LEFT JOIN branches b ON b.id = e.branch_id`;

async function setShifts(tx: Tx, restaurantId: string, employeeId: string, shiftIds: string[]) {
  // End current assignments not in the new set; add new ones from today.
  await tx.query(
    `UPDATE shift_assignments SET effective_to = GREATEST(effective_from, CURRENT_DATE - 1)
      WHERE employee_id = $1 AND (effective_to IS NULL OR effective_to >= CURRENT_DATE) AND NOT (shift_id = ANY($2::uuid[]))`,
    [employeeId, shiftIds],
  );
  // Remove assignments that never took effect.
  await tx.query(`DELETE FROM shift_assignments WHERE employee_id = $1 AND effective_to < effective_from`, [employeeId]);
  for (const sid of shiftIds) {
    await tx.query(
      `INSERT INTO shift_assignments (restaurant_id, employee_id, shift_id, effective_from)
       SELECT $1, $2, $3, CURRENT_DATE
        WHERE NOT EXISTS (SELECT 1 FROM shift_assignments WHERE employee_id = $2 AND shift_id = $3 AND (effective_to IS NULL OR effective_to >= CURRENT_DATE))`,
      [restaurantId, employeeId, sid],
    );
  }
}

/** Deletes every biometric artefact for an employee; attendance records are retained. */
export async function deleteBiometrics(tx: Tx, restaurantId: string, employeeId: string): Promise<number> {
  const enr = await tx.query<{ id: string }>(
    `UPDATE face_enrollments SET status = 'deleted', deleted_at = now() WHERE employee_id = $1 AND restaurant_id = $2 AND status <> 'deleted' RETURNING id`,
    [employeeId, restaurantId],
  );
  const t = await tx.query('DELETE FROM face_templates WHERE employee_id = $1 AND restaurant_id = $2', [employeeId, restaurantId]);
  await tx.query('DELETE FROM employee_photos WHERE employee_id = $1 AND restaurant_id = $2', [employeeId, restaurantId]);
  return (t.rowCount ?? 0) + (enr.rowCount ?? 0);
}

export function registerEmployeeRoutes(app: FastifyInstance, ctx: AppCtx) {
  app.get('/api/employees', { preHandler: requireUser(ctx, 'employees.read') }, async (req) => {
    const a = req.userAuth!;
    const q = parse(z.object({ status: z.enum(['active', 'suspended', 'deactivated', 'all']).default('all'), q: z.string().max(80).optional(), branch_id: uuid.optional() }), req.query);
    return withTenant(ctx.db, a.restaurantId, async (tx) => ({
      employees: (
        await tx.query(
          `${EMP_SELECT} WHERE e.restaurant_id = $1 AND ($2 = 'all' OR e.status::text = $2)
             AND ($3::text IS NULL OR e.full_name ILIKE '%' || $3 || '%' OR e.staff_id ILIKE '%' || $3 || '%')
             AND ($4::uuid IS NULL OR e.branch_id = $4)
           ORDER BY e.status, e.full_name`,
          [a.restaurantId, q.status, q.q ?? null, q.branch_id ?? null],
        )
      ).rows,
    }));
  });

  app.post('/api/employees', { preHandler: requireUser(ctx, 'employees.write') }, async (req, reply) => {
    const a = req.userAuth!;
    const b = parse(z.object({ ...employeeFields, pin: z.string().regex(/^\d{4,8}$/).optional() }), req.body);
    const pinHash = b.pin ? await hashSecret(b.pin) : null;
    const emp = await withTenant(ctx.db, a.restaurantId, async (tx) => {
      const r = await tx.query<{ id: string }>(
        `INSERT INTO employees (restaurant_id, staff_id, full_name, preferred_name, job_title, department, email, branch_id, pin_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [a.restaurantId, b.staff_id, b.full_name, b.preferred_name ?? null, b.job_title ?? null, b.department ?? null, b.email ?? null, b.branch_id ?? null, pinHash],
      ).catch((e) => {
        if (e.code === '23505') throw new HttpError(409, 'staff_id_taken', `Staff ID ${b.staff_id} is already used`);
        throw e;
      });
      const id = r.rows[0].id;
      if (b.shift_ids?.length) await setShifts(tx, a.restaurantId, id, b.shift_ids);
      await audit(tx, a.restaurantId, { type: 'user', id: a.userId, ip: req.ip }, 'employee.created', { type: 'employee', id }, { staff_id: b.staff_id });
      return (await tx.query(`${EMP_SELECT} WHERE e.id = $1`, [id])).rows[0];
    });
    return reply.status(201).send({ employee: emp });
  });

  app.get('/api/employees/:id', { preHandler: requireUser(ctx, 'employees.read') }, async (req) => {
    const a = req.userAuth!;
    const { id } = parse(z.object({ id: uuid }), req.params);
    return withTenant(ctx.db, a.restaurantId, async (tx) => {
      const emp = (await tx.query(`${EMP_SELECT} WHERE e.id = $1 AND e.restaurant_id = $2`, [id, a.restaurantId])).rows[0];
      if (!emp) throw notFound('Employee');
      const enrollments = (await tx.query(
        `SELECT f.id, f.status, f.model, f.template_count, f.consent_method, f.consent_notice_version, f.consent_recorded_at,
                f.created_at, f.confirmed_at, f.revoked_at, f.deleted_at, u1.full_name AS enrolled_by, u2.full_name AS confirmed_by
           FROM face_enrollments f LEFT JOIN users u1 ON u1.id = f.enrolled_by_user_id LEFT JOIN users u2 ON u2.id = f.confirmed_by_user_id
          WHERE f.employee_id = $1 ORDER BY f.created_at DESC`,
        [id],
      )).rows;
      return { employee: emp, enrollments };
    });
  });

  app.patch('/api/employees/:id', { preHandler: requireUser(ctx, 'employees.write') }, async (req) => {
    const a = req.userAuth!;
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(z.object(employeeFields).partial(), req.body);
    return withTenant(ctx.db, a.restaurantId, async (tx) => {
      const cur = (await tx.query('SELECT id FROM employees WHERE id = $1 AND restaurant_id = $2 FOR UPDATE', [id, a.restaurantId])).rows[0];
      if (!cur) throw notFound('Employee');
      const cols = ['full_name', 'preferred_name', 'staff_id', 'job_title', 'department', 'email', 'branch_id'] as const;
      const sets: string[] = [];
      const vals: unknown[] = [id];
      for (const c of cols) {
        if (b[c] !== undefined) {
          vals.push(b[c]);
          sets.push(`${c} = $${vals.length}`);
        }
      }
      if (sets.length) {
        await tx.query(`UPDATE employees SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, vals).catch((e) => {
          if (e.code === '23505') throw new HttpError(409, 'staff_id_taken', 'That staff ID is already used');
          throw e;
        });
      }
      if (b.shift_ids) await setShifts(tx, a.restaurantId, id, b.shift_ids);
      await audit(tx, a.restaurantId, { type: 'user', id: a.userId, ip: req.ip }, 'employee.updated', { type: 'employee', id }, { fields: Object.keys(b) });
      return { employee: (await tx.query(`${EMP_SELECT} WHERE e.id = $1`, [id])).rows[0] };
    });
  });

  app.post('/api/employees/:id/status', { preHandler: requireUser(ctx, 'employees.write') }, async (req) => {
    const a = req.userAuth!;
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(z.object({ status: z.enum(['active', 'suspended', 'deactivated']), delete_biometrics: z.boolean().default(true) }), req.body);
    return withTenant(ctx.db, a.restaurantId, async (tx) => {
      const r = await tx.query(
        `UPDATE employees SET status = $3::employee_status, updated_at = now(), deactivated_at = CASE WHEN $3::text = 'deactivated' THEN now() ELSE NULL END
          WHERE id = $1 AND restaurant_id = $2 RETURNING id`,
        [id, a.restaurantId, b.status],
      );
      if (!r.rowCount) throw notFound('Employee');
      let deleted = 0;
      // Offboarding: biometric data is no longer needed once employment ends.
      if (b.status === 'deactivated' && b.delete_biometrics) deleted = await deleteBiometrics(tx, a.restaurantId, id);
      await audit(tx, a.restaurantId, { type: 'user', id: a.userId, ip: req.ip }, `employee.${b.status}`, { type: 'employee', id }, { biometrics_deleted: deleted > 0 });
      ctx.templates.invalidate(a.restaurantId);
      return { employee: (await tx.query(`${EMP_SELECT} WHERE e.id = $1`, [id])).rows[0] };
    });
  });

  app.post('/api/employees/:id/pin', { preHandler: requireUser(ctx, 'employees.write') }, async (req) => {
    const a = req.userAuth!;
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(z.object({ pin: z.string().regex(/^\d{4,8}$/, 'PIN must be 4–8 digits').nullable() }), req.body);
    const hash = b.pin ? await hashSecret(b.pin) : null;
    await withTenant(ctx.db, a.restaurantId, async (tx) => {
      const r = await tx.query('UPDATE employees SET pin_hash = $3, pin_failed = 0, pin_locked_until = NULL, updated_at = now() WHERE id = $1 AND restaurant_id = $2', [id, a.restaurantId, hash]);
      if (!r.rowCount) throw notFound('Employee');
      await audit(tx, a.restaurantId, { type: 'user', id: a.userId, ip: req.ip }, b.pin ? 'employee.pin_set' : 'employee.pin_cleared', { type: 'employee', id });
    });
    return { ok: true };
  });

  app.get('/api/employees/:id/photo', { preHandler: requireUser(ctx, 'employees.read') }, async (req, reply) => {
    const a = req.userAuth!;
    const { id } = parse(z.object({ id: uuid }), req.params);
    const row = await withTenant(ctx.db, a.restaurantId, async (tx) => (await tx.query<{ mime: string; data: Buffer }>('SELECT mime, data FROM employee_photos WHERE employee_id = $1 AND restaurant_id = $2', [id, a.restaurantId])).rows[0]);
    if (!row) throw notFound('Photo');
    reply.header('Cache-Control', 'private, max-age=300').type(row.mime);
    return reply.send(row.data);
  });

  app.delete('/api/employees/:id/biometrics', { preHandler: requireUser(ctx, 'biometrics.manage') }, async (req) => {
    const a = req.userAuth!;
    const { id } = parse(z.object({ id: uuid }), req.params);
    await withTenant(ctx.db, a.restaurantId, async (tx) => {
      const e = await tx.query('SELECT 1 FROM employees WHERE id = $1 AND restaurant_id = $2', [id, a.restaurantId]);
      if (!e.rowCount) throw notFound('Employee');
      await deleteBiometrics(tx, a.restaurantId, id);
      await audit(tx, a.restaurantId, { type: 'user', id: a.userId, ip: req.ip }, 'biometrics.deleted', { type: 'employee', id });
    });
    ctx.templates.invalidate(a.restaurantId);
    return { ok: true };
  });

  // Enrollment review (identity confirmation by owner/manager before templates become active).
  app.get('/api/enrollments', { preHandler: requireUser(ctx, 'biometrics.manage') }, async (req) => {
    const a = req.userAuth!;
    const q = parse(z.object({ status: z.enum(['pending_confirmation', 'active', 'revoked', 'deleted']).default('pending_confirmation') }), req.query);
    return withTenant(ctx.db, a.restaurantId, async (tx) => ({
      enrollments: (await tx.query(
        `SELECT f.id, f.status, f.created_at, f.template_count, f.consent_method, e.id AS employee_id, e.full_name, e.staff_id,
                EXISTS (SELECT 1 FROM employee_photos p WHERE p.employee_id = e.id) AS has_photo, u.full_name AS enrolled_by, d.name AS device_name
           FROM face_enrollments f JOIN employees e ON e.id = f.employee_id
           LEFT JOIN users u ON u.id = f.enrolled_by_user_id LEFT JOIN devices d ON d.id = f.device_id
          WHERE f.restaurant_id = $1 AND f.status = $2 ORDER BY f.created_at DESC LIMIT 200`,
        [a.restaurantId, q.status],
      )).rows,
    }));
  });

  app.post('/api/enrollments/:id/:decision', { preHandler: requireUser(ctx, 'biometrics.manage') }, async (req) => {
    const a = req.userAuth!;
    const { id, decision } = parse(z.object({ id: uuid, decision: z.enum(['confirm', 'reject']) }), req.params);
    await withTenant(ctx.db, a.restaurantId, async (tx) => {
      const f = (await tx.query<{ employee_id: string; status: string }>('SELECT employee_id, status FROM face_enrollments WHERE id = $1 AND restaurant_id = $2 FOR UPDATE', [id, a.restaurantId])).rows[0];
      if (!f) throw notFound('Enrollment');
      if (f.status !== 'pending_confirmation') throw new HttpError(409, 'not_pending', 'This enrollment is not awaiting confirmation');
      if (decision === 'confirm') {
        await tx.query(`UPDATE face_enrollments SET status = 'active', confirmed_by_user_id = $2, confirmed_at = now() WHERE id = $1`, [id, a.userId]);
      } else {
        await tx.query(`UPDATE face_enrollments SET status = 'deleted', deleted_at = now() WHERE id = $1`, [id]);
        await tx.query('DELETE FROM face_templates WHERE enrollment_id = $1', [id]);
      }
      await audit(tx, a.restaurantId, { type: 'user', id: a.userId, ip: req.ip }, `biometrics.enrollment_${decision}ed`, { type: 'employee', id: f.employee_id }, { enrollment_id: id });
    });
    ctx.templates.invalidate(a.restaurantId);
    return { ok: true };
  });

  app.get('/api/employees/:id/attendance', { preHandler: requireUser(ctx, 'attendance.read') }, async (req) => {
    const a = req.userAuth!;
    const { id } = parse(z.object({ id: uuid }), req.params);
    const q = parse(z.object({ from: ymd.optional(), to: ymd.optional() }), req.query);
    return withTenant(ctx.db, a.restaurantId, async (tx) => {
      const tz = (await tx.query<{ timezone: string }>('SELECT timezone FROM restaurants WHERE id = $1', [a.restaurantId])).rows[0].timezone;
      const sessions = (await tx.query(
        `SELECT s.id, s.status, s.check_in_at, s.check_out_at, s.corrected_check_in_at, s.corrected_check_out_at, s.is_corrected,
                s.scheduled_start, s.scheduled_end, s.late_minutes, s.is_late, s.break_minutes, s.worked_minutes, s.overtime_minutes,
                s.needs_review, sh.name AS shift_name
           FROM attendance_sessions s LEFT JOIN shifts sh ON sh.id = s.shift_id
          WHERE s.employee_id = $1 AND s.restaurant_id = $2
            AND ($3::date IS NULL OR s.check_in_at >= ($3::date)::timestamp AT TIME ZONE $5)
            AND ($4::date IS NULL OR s.check_in_at < ($4::date + 1)::timestamp AT TIME ZONE $5)
          ORDER BY s.check_in_at DESC LIMIT 500`,
        [id, a.restaurantId, q.from ?? null, q.to ?? null, tz],
      )).rows;
      const corrections = (await tx.query(
        `SELECT c.*, u1.full_name AS requested_by, u2.full_name AS decided_by FROM attendance_corrections c
           LEFT JOIN users u1 ON u1.id = c.requested_by_user_id LEFT JOIN users u2 ON u2.id = c.decided_by_user_id
          WHERE c.employee_id = $1 ORDER BY c.created_at DESC LIMIT 100`,
        [id],
      )).rows;
      return { sessions, corrections };
    });
  });

  /** Data-access request (PDPA): everything held about the employee, excluding biometric templates. */
  app.get('/api/employees/:id/export', { preHandler: requireUser(ctx, 'employees.write') }, async (req, reply) => {
    const a = req.userAuth!;
    const { id } = parse(z.object({ id: uuid }), req.params);
    const data = await withTenant(ctx.db, a.restaurantId, async (tx) => {
      const profile = (await tx.query(`SELECT id, staff_id, full_name, preferred_name, job_title, department, email, status, created_at, updated_at, deactivated_at FROM employees WHERE id = $1 AND restaurant_id = $2`, [id, a.restaurantId])).rows[0];
      if (!profile) throw notFound('Employee');
      const q = (sql: string) => tx.query(sql, [id]).then((r) => r.rows);
      const out = {
        generated_at: new Date().toISOString(),
        note: 'Biometric templates are encrypted numeric vectors and are not included. A stored reference photo, if any, is available separately.',
        profile,
        face_enrollments: await q(`SELECT id, status, model, template_count, consent_method, consent_notice_version, consent_recorded_at, created_at, confirmed_at, revoked_at, deleted_at FROM face_enrollments WHERE employee_id = $1`),
        attendance_events: await q(`SELECT id, event_type, event_time, device_timestamp, server_received_at, source, verification_status, recorded_offline, exception_flags FROM attendance_events WHERE employee_id = $1 ORDER BY event_time`),
        attendance_sessions: await q(`SELECT id, status, check_in_at, check_out_at, corrected_check_in_at, corrected_check_out_at, late_minutes, worked_minutes, break_minutes, overtime_minutes FROM attendance_sessions WHERE employee_id = $1 ORDER BY check_in_at`),
        corrections: await q(`SELECT id, kind, original_values, new_values, reason, status, created_at, decided_at FROM attendance_corrections WHERE employee_id = $1`),
      };
      await audit(tx, a.restaurantId, { type: 'user', id: a.userId, ip: req.ip }, 'employee.data_exported', { type: 'employee', id });
      return out;
    });
    reply.header('Content-Disposition', `attachment; filename="employee-${data.profile.staff_id}-data.json"`);
    return data;
  });
}
