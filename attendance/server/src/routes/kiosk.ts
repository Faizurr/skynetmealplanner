import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { withTenant } from '../db.js';
import { newToken, normalizePairingCode, sha256 } from '../crypto.js';
import { audit } from '../audit.js';
import {
  AttendanceRejected,
  loadRestaurant,
  raiseException,
  recordAttendance,
  reportUnknownFace,
  type AttendanceInput,
} from '../attendance.js';
import { cosine, decodeEmbedding, encodeEmbedding, EMBEDDING_DIM, FACE_MODEL, identify } from '../face.js';
import { enqueueNotification, renderEmail } from '../notifications.js';
import { formatDate, formatTime } from '../time.js';
import { HttpError, notFound, parse, requireDevice, requireKioskManager, uuid, type AppCtx } from '../http.js';
import { authenticate, createSession } from './auth.js';

export const CONSENT_NOTICE_VERSION = '2026-10-v1';

const embeddingB64 = z.string().max(1024);

const attendanceSchema = z.object({
  event_id: uuid,
  action: z.enum(['check_in', 'check_out']),
  method: z.enum(['face', 'pin']),
  employee_id: uuid.optional().nullable(),
  embedding: embeddingB64.optional().nullable(),
  match_score: z.number().min(-1).max(1).optional().nullable(),
  liveness_passed: z.boolean().optional().nullable(),
  staff_id: z.string().max(32).optional().nullable(),
  pin: z.string().regex(/^\d{4,8}$/).optional().nullable(),
  device_timestamp: z.string().datetime({ offset: true }).optional().nullable(),
  offline: z.boolean().default(false),
});

/**
 * Runs an attendance submission in its own tenant transaction. Rejections are returned
 * (not thrown) from inside the transaction so side effects such as PIN-failure counters
 * and security exceptions are committed, then re-thrown for the HTTP layer.
 */
export async function runAttendance(ctx: AppCtx, restaurantId: string, input: Omit<AttendanceInput, 'restaurantId'>) {
  const out = await withTenant(ctx.db, restaurantId, async (tx) => {
    const r = await loadRestaurant(tx, restaurantId, ctx.cfg.PUBLIC_BASE_URL);
    try {
      return { ok: true as const, value: await recordAttendance(tx, r, ctx.templates, { ...input, restaurantId }) };
    } catch (err) {
      if (!(err instanceof AttendanceRejected)) throw err;
      await audit(tx, restaurantId, input.actor, 'attendance.rejected', { type: 'attendance_event', id: input.eventId }, {
        code: err.code, action: input.action, method: input.method, offline: input.offline,
      });
      // An offline event the server cannot accept must not vanish silently.
      if (input.offline && err.code !== 'event_id_conflict') {
        const key = `sync_failure:${input.eventId}`;
        const created = await raiseException(tx, restaurantId, {
          kind: 'sync_failure', severity: 'warning', dedupeKey: key, deviceId: input.deviceId, employeeId: input.claimedEmployeeId ?? null, eventId: input.eventId,
          details: { code: err.code, action: input.action, device_timestamp: input.deviceTimestamp?.toISOString() ?? null, message: err.message },
        });
        if (created) {
          await enqueueNotification(tx, restaurantId, r.timezone, 'sync_failure', key, () =>
            renderEmail({
              restaurantName: r.name,
              heading: 'Offline attendance could not be synchronised',
              intro: 'A kiosk recorded attendance while offline, but the server could not accept it. Please review it and add a correction if needed.',
              rows: [
                ['Action', input.action === 'check_in' ? 'Check-in' : 'Check-out'],
                ...(input.deviceTimestamp ? [['Device time', `${formatDate(input.deviceTimestamp, r.timezone)} ${formatTime(input.deviceTimestamp, r.timezone)}`] as [string, string]] : []),
                ['Reason', err.message],
              ],
              link: { href: `${r.publicBaseUrl}/#/alerts`, label: 'Open alerts' },
            }),
          );
        }
      }
      return { ok: false as const, err };
    }
  });
  if (!out.ok) throw out.err;
  return out.value;
}

function templatesEtag(payload: unknown): string {
  return `"${createHash('sha256').update(JSON.stringify(payload)).digest('base64url').slice(0, 32)}"`;
}

export function registerKioskRoutes(app: FastifyInstance, ctx: AppCtx) {
  const device = requireDevice(ctx);

  // --- Pairing: owner creates a device + one-time code in the dashboard; kiosk redeems it.
  app.post('/api/kiosk/pair', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const body = parse(
      z.object({ code: z.string().min(6).max(20), device_model: z.string().max(120).optional(), app_version: z.string().max(40).optional() }),
      req.body,
    );
    const hash = sha256(normalizePairingCode(body.code));
    const d = (await ctx.db.query<{ device_id: string; restaurant_id: string; pairing_expires_at: Date | null; status: string }>('SELECT * FROM auth_device_by_pairing_code($1)', [hash])).rows[0];
    if (!d || d.status === 'revoked' || !d.pairing_expires_at || d.pairing_expires_at < new Date()) {
      throw new HttpError(400, 'invalid_pairing_code', 'This pairing code is invalid or has expired. Create a new one in the dashboard.');
    }
    const { token, hash: tokenHash } = newToken();
    await withTenant(ctx.db, d.restaurant_id, async (tx) => {
      await tx.query(
        `UPDATE devices SET status = 'active', token_hash = $2, pairing_code_hash = NULL, pairing_expires_at = NULL,
                paired_at = now(), last_seen_at = now(), device_model = $3, app_version = $4 WHERE id = $1`,
        [d.device_id, tokenHash, body.device_model ?? null, body.app_version ?? null],
      );
      await audit(tx, d.restaurant_id, { type: 'device', id: d.device_id, ip: req.ip }, 'device.paired', { type: 'device', id: d.device_id }, { device_model: body.device_model });
    });
    return { device_id: d.device_id, device_token: token };
  });

  app.get('/api/kiosk/config', { preHandler: device }, async (req) => {
    const da = req.deviceAuth!;
    return withTenant(ctx.db, da.restaurantId, async (tx) => {
      const r = await loadRestaurant(tx, da.restaurantId, ctx.cfg.PUBLIC_BASE_URL);
      const branch = da.branchId ? (await tx.query('SELECT id, name FROM branches WHERE id = $1', [da.branchId])).rows[0] : null;
      const s = r.settings;
      return {
        server_time: new Date().toISOString(),
        restaurant: { id: r.id, name: r.name, timezone: r.timezone },
        branch,
        device: { id: da.deviceId, name: da.name },
        face_model: FACE_MODEL,
        settings: {
          match_threshold: s.match_threshold,
          match_margin: s.match_margin,
          liveness_required: s.liveness_required,
          pin_fallback_enabled: s.pin_fallback_enabled,
          success_return_seconds: s.success_return_seconds,
          sound_enabled: s.sound_enabled,
          employee_instructions: s.employee_instructions,
          offline_mode_enabled: s.offline_mode_enabled,
          max_offline_age_hours: s.max_offline_age_hours,
          min_minutes_between_in_and_out: s.min_minutes_between_in_and_out,
        },
        consent_notice_version: CONSENT_NOTICE_VERSION,
      };
    });
  });

  /**
   * Active templates for on-device matching. Sent only to authenticated, active devices of
   * the same restaurant over TLS; the kiosk stores them encrypted with an Android Keystore key.
   */
  app.get('/api/kiosk/templates', { preHandler: device }, async (req, reply) => {
    const da = req.deviceAuth!;
    const payload = await withTenant(ctx.db, da.restaurantId, async (tx) => {
      const sets = await ctx.templates.get(da.restaurantId, tx);
      const emps = (await tx.query<{ id: string; full_name: string; preferred_name: string | null; staff_id: string }>(
        `SELECT id, full_name, preferred_name, staff_id FROM employees WHERE restaurant_id = $1 AND status = 'active'`,
        [da.restaurantId],
      )).rows;
      const byId = new Map(emps.map((e) => [e.id, e]));
      return {
        model: FACE_MODEL,
        employees: sets
          .filter((s) => byId.has(s.employeeId))
          .map((s) => ({ ...byId.get(s.employeeId)!, templates: s.vectors.map(encodeEmbedding) }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      };
    });
    const etag = templatesEtag(payload);
    reply.header('ETag', etag);
    if (req.headers['if-none-match'] === etag) return reply.status(304).send();
    return payload;
  });

  app.post('/api/kiosk/attendance', { preHandler: device, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const da = req.deviceAuth!;
    const b = parse(attendanceSchema, req.body);
    let probe: Float32Array | null = null;
    if (b.method === 'face') {
      if (!b.embedding) throw new HttpError(400, 'invalid_request', 'embedding is required for face attendance');
      try {
        probe = decodeEmbedding(b.embedding);
      } catch (e) {
        throw new HttpError(400, 'invalid_embedding', (e as Error).message);
      }
    }
    const result = await runAttendance(ctx, da.restaurantId, {
      eventId: b.event_id,
      action: b.action,
      method: b.method,
      deviceId: da.deviceId,
      branchId: da.branchId,
      claimedEmployeeId: b.employee_id ?? null,
      probe,
      deviceMatchScore: b.match_score ?? null,
      livenessPassed: b.liveness_passed ?? null,
      staffId: b.staff_id ?? null,
      pin: b.pin ?? null,
      deviceTimestamp: b.device_timestamp ? new Date(b.device_timestamp) : null,
      offline: b.offline,
      actor: { type: 'device', id: da.deviceId, ip: req.ip },
    });
    return result;
  });

  app.post('/api/kiosk/unknown-face', { preHandler: device, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const da = req.deviceAuth!;
    const b = parse(z.object({ action: z.enum(['check_in', 'check_out']), best_score: z.number().min(-1).max(1).nullable().optional() }), req.body);
    await withTenant(ctx.db, da.restaurantId, async (tx) => {
      const r = await loadRestaurant(tx, da.restaurantId, ctx.cfg.PUBLIC_BASE_URL);
      await reportUnknownFace(tx, r, { id: da.deviceId, name: da.name, branchId: da.branchId }, { action: b.action, bestScore: b.best_score ?? null, at: new Date() });
    });
    return { ok: true };
  });

  app.post('/api/kiosk/heartbeat', { preHandler: device }, async (req) => {
    const da = req.deviceAuth!;
    const b = parse(
      z.object({
        app_version: z.string().max(40).optional(),
        app_version_code: z.number().int().optional(),
        pending_queue_count: z.number().int().min(0).max(100000).default(0),
        failed_queue_count: z.number().int().min(0).max(100000).default(0),
        last_error: z.string().max(500).nullable().optional(),
        synced: z.boolean().default(false),
      }),
      req.body,
    );
    await withTenant(ctx.db, da.restaurantId, async (tx) => {
      await tx.query(
        `UPDATE devices SET last_seen_at = now(), app_version = COALESCE($2, app_version), pending_queue_count = $3,
                last_error = $4, last_sync_at = CASE WHEN $5 THEN now() ELSE last_sync_at END WHERE id = $1`,
        [da.deviceId, b.app_version ?? null, b.pending_queue_count, b.last_error ?? null, b.synced],
      );
      await tx.query(
        `UPDATE attendance_exceptions SET status = 'resolved', resolved_at = now(), resolution_note = 'Device reconnected'
          WHERE restaurant_id = $1 AND device_id = $2 AND kind = 'device_offline' AND status = 'open'`,
        [da.restaurantId, da.deviceId],
      );
    });
    return { ok: true, server_time: new Date().toISOString() };
  });

  // --- Manager mode on the kiosk (enrollment etc.). Uses owner/manager credentials.
  app.post('/api/kiosk/manager/login', { preHandler: device, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const da = req.deviceAuth!;
    const b = parse(z.object({ email: z.string().email(), password: z.string().min(1).max(200) }), req.body);
    const u = await authenticate(ctx, b.email, b.password);
    const m = await ctx.db.query<{ role: string }>('SELECT role FROM memberships WHERE user_id = $1 AND restaurant_id = $2', [u.id, da.restaurantId]);
    const role = m.rows[0]?.role;
    if (role !== 'owner' && role !== 'manager') throw new HttpError(403, 'forbidden', 'Only owners and managers can open manager mode');
    const token = await createSession(ctx, req, u.id, da.restaurantId, 'kiosk_manager', da.deviceId);
    await withTenant(ctx.db, da.restaurantId, (tx) => audit(tx, da.restaurantId, { type: 'user', id: u.id, ip: req.ip }, 'kiosk.manager_login', { type: 'device', id: da.deviceId }));
    return { manager_token: token, full_name: u.full_name, role, expires_in_seconds: 900 };
  });

  app.get('/api/kiosk/manager/employees', { preHandler: device }, async (req) => {
    const da = req.deviceAuth!;
    await requireKioskManager(ctx, req, 'biometrics.manage');
    return withTenant(ctx.db, da.restaurantId, async (tx) => ({
      employees: (
        await tx.query(
          `SELECT e.id, e.full_name, e.preferred_name, e.staff_id, e.job_title, e.status,
                  (SELECT status FROM face_enrollments f WHERE f.employee_id = e.id AND f.status IN ('active','pending_confirmation') LIMIT 1) AS enrollment_status
             FROM employees e WHERE e.restaurant_id = $1 AND e.status = 'active' ORDER BY e.full_name`,
          [da.restaurantId],
        )
      ).rows,
    }));
  });

  app.post('/api/kiosk/manager/enrollments', { preHandler: device, bodyLimit: 1_500_000 }, async (req: FastifyRequest) => {
    const da = req.deviceAuth!;
    const mgr = await requireKioskManager(ctx, req, 'biometrics.manage');
    const b = parse(
      z.object({
        employee_id: uuid,
        embeddings: z.array(embeddingB64).min(3).max(10),
        consent: z.object({
          confirmed: z.literal(true),
          method: z.enum(['written_form', 'digital_acknowledgement', 'verbal_witnessed']),
          notice_version: z.string().max(40),
        }),
        confirm_identity: z.boolean(),
        photo_jpeg_base64: z.string().max(700_000).optional().nullable(),
      }),
      req.body,
    );
    const vectors = b.embeddings.map((e) => {
      try {
        return decodeEmbedding(e);
      } catch (err) {
        throw new HttpError(400, 'invalid_embedding', (err as Error).message);
      }
    });
    // Quality gate: samples must be mutually consistent (same person, usable images).
    let minPair = 1;
    for (let i = 0; i < vectors.length; i++) for (let j = i + 1; j < vectors.length; j++) minPair = Math.min(minPair, cosine(vectors[i], vectors[j]));

    const result = await withTenant(ctx.db, da.restaurantId, async (tx) => {
      const r = await loadRestaurant(tx, da.restaurantId, ctx.cfg.PUBLIC_BASE_URL);
      if (minPair < Math.max(0.4, r.settings.match_threshold - 0.05)) {
        throw new HttpError(422, 'inconsistent_samples', 'The captured samples do not look consistent. Make sure only the employee is in frame, with good lighting, and try again.', {
          min_pair_similarity: Number(minPair.toFixed(3)),
        });
      }
      const emp = (await tx.query<{ id: string; full_name: string; status: string }>('SELECT id, full_name, status FROM employees WHERE id = $1 AND restaurant_id = $2 FOR UPDATE', [b.employee_id, da.restaurantId])).rows[0];
      if (!emp) throw notFound('Employee');
      if (emp.status !== 'active') throw new HttpError(409, 'employee_inactive', 'Only active employees can be enrolled');

      // Never let one face be enrolled under two employees.
      const others = (await ctx.templates.get(da.restaurantId, tx)).filter((s) => s.employeeId !== emp.id);
      for (const v of vectors) {
        const m = identify(v, others, r.settings.match_threshold, 0);
        if (m.accepted && m.employeeId) {
          const other = (await tx.query<{ full_name: string; staff_id: string }>('SELECT full_name, staff_id FROM employees WHERE id = $1', [m.employeeId])).rows[0];
          throw new HttpError(409, 'face_already_enrolled', `This face already matches ${other?.full_name ?? 'another employee'} (${other?.staff_id ?? ''}). Remove that enrollment first if this is a mistake.`);
        }
      }

      // Replace any previous live enrollment: old templates are destroyed, metadata kept for audit.
      const prev = await tx.query<{ id: string }>(
        `UPDATE face_enrollments SET status = 'revoked', revoked_at = now() WHERE employee_id = $1 AND status IN ('active','pending_confirmation') RETURNING id`,
        [emp.id],
      );
      if (prev.rowCount) await tx.query('DELETE FROM face_templates WHERE enrollment_id = ANY($1::uuid[])', [prev.rows.map((x) => x.id)]);

      const status = b.confirm_identity ? 'active' : 'pending_confirmation';
      const enr = (
        await tx.query<{ id: string }>(
          `INSERT INTO face_enrollments (restaurant_id, employee_id, status, model, template_count, consent_recorded_at, consent_method,
                  consent_notice_version, enrolled_by_user_id, confirmed_by_user_id, confirmed_at, device_id)
           VALUES ($1,$2,$3,$4,$5, now(), $6, $7, $8, $9, $10, $11) RETURNING id`,
          [da.restaurantId, emp.id, status, FACE_MODEL, vectors.length, b.consent.method, b.consent.notice_version, mgr.userId,
            b.confirm_identity ? mgr.userId : null, b.confirm_identity ? new Date() : null, da.deviceId],
        )
      ).rows[0];
      for (const v of vectors) {
        const plain = Buffer.alloc(EMBEDDING_DIM * 4);
        v.forEach((x, i) => plain.writeFloatLE(x, i * 4));
        const blob = ctx.cipher.encrypt(plain, `${da.restaurantId}:${emp.id}`);
        await tx.query(
          'INSERT INTO face_templates (enrollment_id, restaurant_id, employee_id, key_version, iv, ciphertext, auth_tag) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [enr.id, da.restaurantId, emp.id, blob.keyVersion, blob.iv, blob.ciphertext, blob.authTag],
        );
      }
      if (b.photo_jpeg_base64) {
        const data = Buffer.from(b.photo_jpeg_base64, 'base64');
        if (data.length > 512 * 1024 || data[0] !== 0xff || data[1] !== 0xd8) throw new HttpError(400, 'invalid_photo', 'Photo must be a JPEG under 512 KB');
        await tx.query(
          `INSERT INTO employee_photos (employee_id, restaurant_id, mime, data) VALUES ($1,$2,'image/jpeg',$3)
           ON CONFLICT (employee_id) DO UPDATE SET data = EXCLUDED.data, created_at = now()`,
          [emp.id, da.restaurantId, data],
        );
      }
      await audit(tx, da.restaurantId, { type: 'user', id: mgr.userId, ip: req.ip }, prev.rowCount ? 'biometrics.re_enrolled' : 'biometrics.enrolled', { type: 'employee', id: emp.id }, {
        enrollment_id: enr.id, status, samples: vectors.length, consent_method: b.consent.method, device_id: da.deviceId, min_pair_similarity: Number(minPair.toFixed(3)),
      });
      return { enrollment_id: enr.id, status, employee: { id: emp.id, full_name: emp.full_name } };
    });
    ctx.templates.invalidate(da.restaurantId);
    return result;
  });

  /** Verifies a fresh capture against an employee right after enrollment ("test recognition"). */
  app.post('/api/kiosk/manager/verify', { preHandler: device }, async (req) => {
    const da = req.deviceAuth!;
    await requireKioskManager(ctx, req, 'biometrics.manage');
    const b = parse(z.object({ embedding: embeddingB64 }), req.body);
    const probe = decodeEmbedding(b.embedding);
    return withTenant(ctx.db, da.restaurantId, async (tx) => {
      const r = await loadRestaurant(tx, da.restaurantId, ctx.cfg.PUBLIC_BASE_URL);
      const m = identify(probe, await ctx.templates.get(da.restaurantId, tx), r.settings.match_threshold, r.settings.match_margin);
      const emp = m.employeeId ? (await tx.query('SELECT id, full_name, staff_id FROM employees WHERE id = $1', [m.employeeId])).rows[0] : null;
      return { accepted: m.accepted, reason: m.reason ?? null, score: Number(m.score.toFixed(4)), employee: m.accepted ? emp : null };
    });
  });
}
