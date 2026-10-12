import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { withTenant, withTx } from '../db.js';
import { hashSecret, newToken, verifySecret } from '../crypto.js';
import { audit } from '../audit.js';
import { isValidTimeZone } from '../time.js';
import { HttpError, PERMISSIONS, SESSION_COOKIE, clientIp, parse, requireUser, type AppCtx, type Role } from '../http.js';

const SESSION_DAYS = 14;
export const passwordSchema = z.string().min(10, 'Use at least 10 characters').max(200);

function setSessionCookie(ctx: AppCtx, reply: FastifyReply, token: string) {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: ctx.cfg.PUBLIC_BASE_URL.startsWith('https://'),
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_DAYS * 86400,
  });
}

export async function createSession(
  ctx: AppCtx,
  req: FastifyRequest,
  userId: string,
  restaurantId: string,
  kind: 'web' | 'kiosk_manager' = 'web',
  deviceId: string | null = null,
): Promise<string> {
  const { token, hash } = newToken();
  const ttl = kind === 'web' ? `${SESSION_DAYS} days` : '15 minutes';
  await ctx.db.query(
    `INSERT INTO user_sessions (token_hash, user_id, restaurant_id, kind, device_id, user_agent, ip, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now() + $8::interval)`,
    [hash, userId, restaurantId, kind, deviceId, String(req.headers['user-agent'] ?? '').slice(0, 300), clientIp(req), ttl],
  );
  return token;
}

/** Verifies credentials with lockout after repeated failures. Returns the user id. */
export async function authenticate(ctx: AppCtx, email: string, password: string): Promise<{ id: string; full_name: string; must_change_password: boolean }> {
  const r = await ctx.db.query<{ id: string; password_hash: string; full_name: string; disabled: boolean; locked_until: Date | null; must_change_password: boolean }>(
    'SELECT id, password_hash, full_name, disabled, locked_until, must_change_password FROM users WHERE email = $1',
    [email.toLowerCase().trim()],
  );
  const u = r.rows[0];
  if (u?.locked_until && u.locked_until > new Date()) {
    throw new HttpError(423, 'account_locked', 'Too many failed sign-in attempts. Try again in 15 minutes.');
  }
  const ok = await verifySecret(password, u?.password_hash);
  if (!u || !ok || u.disabled) {
    if (u) {
      await ctx.db.query(
        `UPDATE users SET failed_logins = failed_logins + 1,
                locked_until = CASE WHEN failed_logins + 1 >= 8 THEN now() + interval '15 minutes' ELSE locked_until END
          WHERE id = $1`,
        [u.id],
      );
    }
    throw new HttpError(401, 'invalid_credentials', 'Email or password is incorrect');
  }
  await ctx.db.query('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [u.id]);
  return u;
}

export function registerAuthRoutes(app: FastifyInstance, ctx: AppCtx) {
  const strict = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  app.post('/api/auth/signup', strict, async (req, reply) => {
    if (!ctx.cfg.SIGNUP_ENABLED) throw new HttpError(403, 'signup_disabled', 'New restaurant sign-up is disabled on this server');
    const body = parse(
      z.object({
        restaurant_name: z.string().trim().min(1).max(120),
        branch_name: z.string().trim().min(1).max(120).default('Main'),
        timezone: z.string().default('Asia/Kuala_Lumpur').refine(isValidTimeZone, 'Unknown time zone'),
        full_name: z.string().trim().min(1).max(120),
        email: z.string().trim().toLowerCase().email(),
        password: passwordSchema,
      }),
      req.body,
    );
    const existing = await ctx.db.query('SELECT 1 FROM users WHERE email = $1', [body.email]);
    if (existing.rowCount) throw new HttpError(409, 'email_taken', 'An account with this email already exists. Sign in instead.');
    const passwordHash = await hashSecret(body.password);
    const restaurantId = randomUUID();
    const userId = await withTenant(ctx.db, restaurantId, async (tx) => {
      await tx.query('INSERT INTO restaurants (id, name, timezone) VALUES ($1,$2,$3)', [restaurantId, body.restaurant_name, body.timezone]);
      await tx.query('INSERT INTO branches (restaurant_id, name) VALUES ($1,$2)', [restaurantId, body.branch_name]);
      const u = await tx.query<{ id: string }>('INSERT INTO users (email, password_hash, full_name) VALUES ($1,$2,$3) RETURNING id', [body.email, passwordHash, body.full_name]);
      await tx.query(`INSERT INTO memberships (user_id, restaurant_id, role) VALUES ($1,$2,'owner')`, [u.rows[0].id, restaurantId]);
      await tx.query('INSERT INTO notification_settings (restaurant_id, emails) VALUES ($1,$2)', [restaurantId, [body.email]]);
      await audit(tx, restaurantId, { type: 'user', id: u.rows[0].id, ip: clientIp(req) }, 'restaurant.created', { type: 'restaurant', id: restaurantId });
      return u.rows[0].id;
    });
    const token = await createSession(ctx, req, userId, restaurantId);
    setSessionCookie(ctx, reply, token);
    return reply.status(201).send({ ok: true, restaurant_id: restaurantId });
  });

  app.post('/api/auth/login', strict, async (req, reply) => {
    const body = parse(z.object({ email: z.string().trim().email(), password: z.string().min(1).max(200), restaurant_id: z.string().uuid().optional() }), req.body);
    const u = await authenticate(ctx, body.email, body.password);
    const memberships = (await ctx.db.query<{ restaurant_id: string; name: string; role: Role }>('SELECT * FROM restaurant_names_for_user($1)', [u.id])).rows;
    if (!memberships.length) throw new HttpError(403, 'no_membership', 'This account is not linked to any restaurant');
    const chosen = body.restaurant_id ? memberships.find((m) => m.restaurant_id === body.restaurant_id) : memberships[0];
    if (!chosen) throw new HttpError(403, 'no_membership', 'You are not a member of that restaurant');
    const token = await createSession(ctx, req, u.id, chosen.restaurant_id);
    await withTenant(ctx.db, chosen.restaurant_id, (tx) => audit(tx, chosen.restaurant_id, { type: 'user', id: u.id, ip: clientIp(req) }, 'auth.login'));
    setSessionCookie(ctx, reply, token);
    return { ok: true, restaurant_id: chosen.restaurant_id };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) {
      const { sha256 } = await import('../crypto.js');
      await ctx.db.query('UPDATE user_sessions SET revoked_at = now() WHERE token_hash = $1', [sha256(token)]);
    }
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', { preHandler: requireUser(ctx) }, async (req) => {
    const a = req.userAuth!;
    const memberships = (await ctx.db.query('SELECT * FROM restaurant_names_for_user($1)', [a.userId])).rows;
    const restaurant = await withTenant(ctx.db, a.restaurantId, async (tx) => (await tx.query('SELECT id, name, timezone FROM restaurants WHERE id = $1', [a.restaurantId])).rows[0]);
    const permissions = Object.entries(PERMISSIONS).filter(([, roles]) => roles.includes(a.role)).map(([p]) => p);
    return {
      user: { id: a.userId, email: a.email, full_name: a.fullName, must_change_password: a.mustChangePassword },
      role: a.role,
      permissions,
      restaurant,
      memberships,
    };
  });

  app.post('/api/auth/switch', { preHandler: requireUser(ctx) }, async (req, reply) => {
    const body = parse(z.object({ restaurant_id: z.string().uuid() }), req.body);
    const a = req.userAuth!;
    const m = await ctx.db.query('SELECT 1 FROM memberships WHERE user_id = $1 AND restaurant_id = $2', [a.userId, body.restaurant_id]);
    if (!m.rowCount) throw new HttpError(403, 'no_membership', 'You are not a member of that restaurant');
    await ctx.db.query('UPDATE user_sessions SET revoked_at = now() WHERE id = $1', [a.sessionId]);
    setSessionCookie(ctx, reply, await createSession(ctx, req, a.userId, body.restaurant_id));
    return { ok: true };
  });

  app.post('/api/auth/change-password', { preHandler: requireUser(ctx), ...strict }, async (req) => {
    const body = parse(z.object({ current_password: z.string().min(1), new_password: passwordSchema }), req.body);
    const a = req.userAuth!;
    await authenticate(ctx, a.email, body.current_password);
    const hash = await hashSecret(body.new_password);
    await withTx(ctx.db, async (tx) => {
      await tx.query('UPDATE users SET password_hash = $2, must_change_password = false WHERE id = $1', [a.userId, hash]);
      // Sign out every other session for this user.
      await tx.query('UPDATE user_sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL', [a.userId, a.sessionId]);
    });
    await withTenant(ctx.db, a.restaurantId, (tx) => audit(tx, a.restaurantId, { type: 'user', id: a.userId, ip: clientIp(req) }, 'auth.password_changed'));
    return { ok: true };
  });
}
