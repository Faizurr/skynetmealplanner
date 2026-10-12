import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z, ZodError, type ZodTypeAny } from 'zod';
import type { Config } from './config.js';
import type { Db } from './db.js';
import type { RealtimeHub } from './realtime.js';
import type { TemplateStore } from './face.js';
import type { TemplateCipher } from './crypto.js';
import type { Mailer } from './mailer.js';
import { sha256 } from './crypto.js';
import { AttendanceRejected } from './attendance.js';

export interface AppCtx {
  cfg: Config;
  db: Db;
  hub: RealtimeHub;
  templates: TemplateStore;
  cipher: TemplateCipher;
  mailer: Mailer | null;
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const notFound = (what = 'Resource') => new HttpError(404, 'not_found', `${what} not found`);
export const forbidden = (msg = 'You do not have permission to do that') => new HttpError(403, 'forbidden', msg);

export function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  return schema.parse(data ?? {});
}

export const uuid = z.string().uuid();
export const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/);

const REJECT_STATUS: Record<string, number> = {
  not_recognized: 422,
  ambiguous_match: 422,
  identity_mismatch: 422,
  liveness_required: 422,
  invalid_request: 400,
  invalid_pin: 401,
  pin_locked: 423,
  employee_not_found: 404,
  employee_inactive: 403,
  pin_disabled: 403,
  offline_disabled: 403,
};

export function installErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.status).send({ error: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) });
    }
    if (err instanceof AttendanceRejected) {
      return reply.status(REJECT_STATUS[err.code] ?? 409).send({ error: err.code, message: err.message, details: err.details });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: 'validation_failed',
        message: 'Some fields are invalid',
        details: { issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) },
      });
    }
    const e = err as { statusCode?: number; code?: string; message?: string; constraint?: string };
    if (e.code === '23505') return reply.status(409).send({ error: 'conflict', message: 'That value is already in use', details: { constraint: e.constraint } });
    if (e.code === '23503') return reply.status(400).send({ error: 'invalid_reference', message: 'A referenced record does not exist' });
    if (e.code === '22P02') return reply.status(400).send({ error: 'invalid_input', message: 'Invalid identifier or value' });
    if (e.statusCode && e.statusCode < 500) return reply.status(e.statusCode).send({ error: e.code ?? 'bad_request', message: e.message });
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ error: 'internal_error', message: 'Something went wrong. Please try again.' });
  });
}

// ---------------------------------------------------------------------------
// Roles & permissions (enforced server-side on every route)
// ---------------------------------------------------------------------------
export type Role = 'owner' | 'manager' | 'attendance_admin';
export type Permission =
  | 'attendance.read'
  | 'attendance.manual'
  | 'attendance.review'
  | 'corrections.request'
  | 'corrections.approve'
  | 'employees.read'
  | 'employees.write'
  | 'biometrics.manage'
  | 'shifts.write'
  | 'devices.manage'
  | 'notifications.manage'
  | 'settings.manage'
  | 'team.manage'
  | 'audit.read'
  | 'reports.export';

const ALL: Role[] = ['owner', 'manager', 'attendance_admin'];
const MGMT: Role[] = ['owner', 'manager'];
export const PERMISSIONS: Record<Permission, Role[]> = {
  'attendance.read': ALL,
  'attendance.manual': MGMT,
  'attendance.review': MGMT,
  'corrections.request': ALL,
  'corrections.approve': MGMT,
  'employees.read': ALL,
  'employees.write': MGMT,
  'biometrics.manage': MGMT,
  'shifts.write': MGMT,
  'devices.manage': MGMT,
  'notifications.manage': ['owner'],
  'settings.manage': ['owner'],
  'team.manage': ['owner'],
  'audit.read': MGMT,
  'reports.export': ALL,
};

export function can(role: Role, p: Permission): boolean {
  return PERMISSIONS[p].includes(role);
}

export interface UserAuth {
  userId: string;
  restaurantId: string;
  role: Role;
  sessionId: string;
  email: string;
  fullName: string;
  mustChangePassword: boolean;
}

export interface DeviceAuth {
  deviceId: string;
  restaurantId: string;
  branchId: string | null;
  name: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    userAuth?: UserAuth;
    deviceAuth?: DeviceAuth;
  }
}

export const SESSION_COOKIE = 'att_session';

async function resolveUserSession(db: Db, token: string, kind: 'web' | 'kiosk_manager'): Promise<UserAuth | null> {
  const r = await db.query<{
    id: string; user_id: string; restaurant_id: string; role: Role; email: string; full_name: string; must_change_password: boolean; device_id: string | null;
  }>(
    `SELECT s.id, s.user_id, s.restaurant_id, m.role, u.email, u.full_name, u.must_change_password, s.device_id
       FROM user_sessions s
       JOIN users u ON u.id = s.user_id AND NOT u.disabled
       JOIN memberships m ON m.user_id = s.user_id AND m.restaurant_id = s.restaurant_id
      WHERE s.token_hash = $1 AND s.kind = $2 AND s.revoked_at IS NULL AND s.expires_at > now()`,
    [sha256(token), kind],
  );
  const row = r.rows[0];
  if (!row) return null;
  return { userId: row.user_id, restaurantId: row.restaurant_id, role: row.role, sessionId: row.id, email: row.email, fullName: row.full_name, mustChangePassword: row.must_change_password };
}

/** preHandler: dashboard session (cookie) + CSRF header on state-changing requests. */
export function requireUser(ctx: AppCtx, permission?: Permission) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (!token) throw new HttpError(401, 'unauthenticated', 'Please sign in');
    const auth = await resolveUserSession(ctx.db, token, 'web');
    if (!auth) throw new HttpError(401, 'unauthenticated', 'Your session has expired. Please sign in again.');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers['x-csrf'] !== '1') {
      // Custom header cannot be set cross-site without a CORS preflight (which we never grant).
      throw new HttpError(403, 'csrf', 'Missing CSRF header');
    }
    if (permission && !can(auth.role, permission)) throw forbidden();
    req.userAuth = auth;
  };
}

/** preHandler: kiosk device bearer token. */
export function requireDevice(ctx: AppCtx) {
  return async (req: FastifyRequest) => {
    const h = req.headers.authorization ?? '';
    const m = /^Bearer (.+)$/.exec(h);
    if (!m) throw new HttpError(401, 'device_unauthenticated', 'Device token missing');
    const r = await ctx.db.query<{ device_id: string; restaurant_id: string; branch_id: string | null; status: string; name: string }>(
      'SELECT * FROM auth_device_by_token($1)',
      [sha256(m[1])],
    );
    const d = r.rows[0];
    if (!d) throw new HttpError(401, 'device_unauthenticated', 'This device is not registered');
    if (d.status !== 'active') throw new HttpError(401, 'device_revoked', 'This device has been revoked. Ask the owner to re-pair it.');
    req.deviceAuth = { deviceId: d.device_id, restaurantId: d.restaurant_id, branchId: d.branch_id, name: d.name };
  };
}

/** For kiosk manager mode: a short-lived user session bound to this device. */
export async function requireKioskManager(ctx: AppCtx, req: FastifyRequest, permission: Permission): Promise<UserAuth> {
  const token = req.headers['x-manager-token'];
  if (typeof token !== 'string') throw new HttpError(401, 'manager_unauthenticated', 'Manager sign-in required');
  const auth = await resolveUserSession(ctx.db, token, 'kiosk_manager');
  if (!auth || auth.restaurantId !== req.deviceAuth?.restaurantId) throw new HttpError(401, 'manager_unauthenticated', 'Manager session expired');
  if (!can(auth.role, permission)) throw forbidden();
  return auth;
}

export function clientIp(req: FastifyRequest): string | null {
  return req.ip ?? null;
}
