import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse, type AppCtx } from '../http.js';

export function registerAppRoutes(app: FastifyInstance, ctx: AppCtx) {
  app.get('/healthz', async () => ({ ok: true }));

  app.get('/readyz', async (_req, reply) => {
    try {
      await ctx.db.query('SELECT 1');
      return { ok: true, realtime_subscribers: ctx.hub.connectionCount() };
    } catch {
      return reply.status(503).send({ ok: false });
    }
  });

  /**
   * Kiosk update check. The kiosk downloads apk_url over HTTPS, verifies the SHA-256 of the
   * file AND that the APK is signed by signing_cert_sha256 (which must equal its own
   * signature) before handing it to the Android package installer.
   */
  app.get('/api/app/android/latest', async (req) => {
    const q = parse(z.object({ current: z.coerce.number().int().min(0).optional() }), req.query);
    const r = await ctx.db.query(
      `SELECT version_code, version_name, apk_url, apk_sha256, signing_cert_sha256, min_supported_version_code, release_notes, published_at
         FROM app_releases WHERE platform = 'android' ORDER BY version_code DESC LIMIT 1`,
    );
    const rel = r.rows[0];
    if (!rel) return { release: null, update_available: false, mandatory: false };
    return {
      release: rel,
      update_available: q.current != null ? rel.version_code > q.current : true,
      mandatory: q.current != null ? q.current < rel.min_supported_version_code : false,
    };
  });
}
