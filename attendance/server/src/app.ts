import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Config } from './config.js';
import { createPool, checkRlsPosture } from './db.js';
import { TemplateCipher, sha256 } from './crypto.js';
import { TemplateStore } from './face.js';
import { RealtimeHub } from './realtime.js';
import { createMailer } from './mailer.js';
import { Worker } from './worker.js';
import { installErrorHandler, type AppCtx } from './http.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerKioskRoutes } from './routes/kiosk.js';
import { registerEmployeeRoutes } from './routes/employees.js';
import { registerAttendanceRoutes } from './routes/attendance.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerInsightRoutes } from './routes/insights.js';
import { registerAppRoutes } from './routes/app.js';
import { registerPayrollRoutes } from './routes/payroll.js';

export interface BuiltApp {
  app: FastifyInstance;
  ctx: AppCtx;
  worker: Worker;
  close: () => Promise<void>;
}

export async function buildApp(cfg: Config, opts: { logger?: boolean; startRealtime?: boolean } = {}): Promise<BuiltApp> {
  const db = createPool(cfg.DATABASE_URL, cfg.DATABASE_SSL);
  const hub = new RealtimeHub(cfg.DATABASE_URL, cfg.DATABASE_SSL);
  const cipher = new TemplateCipher(cfg.templateKeys, cfg.currentKeyVersion);
  const templates = new TemplateStore(db, cipher);
  const mailer = createMailer(cfg);
  const ctx: AppCtx = { cfg, db, hub, templates, cipher, mailer };

  if (opts.startRealtime !== false) {
    await hub.start();
    // Keep the template cache coherent across instances.
    hub.onAny((e) => {
      if (e.table === 'face_enrollments' || e.table === 'employees') templates.invalidate(e.restaurant_id);
    });
  }

  const posture = await checkRlsPosture(db);
  if (!posture.enforced) {
    const msg = `[security] Row-level security is NOT enforced for this connection (${posture.reason}). Tenant isolation relies on application checks only. Connect as a dedicated non-owner role (see docs/DEPLOYMENT.md).`;
    if (cfg.NODE_ENV === 'production') console.warn(msg);
    else if (cfg.NODE_ENV !== 'test') console.warn(msg);
  }

  const app = Fastify({
    logger: opts.logger ?? cfg.NODE_ENV !== 'test' ? { level: cfg.NODE_ENV === 'production' ? 'info' : 'debug', redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-manager-token"]'] } : false,
    trustProxy: cfg.TRUST_PROXY,
    bodyLimit: 256 * 1024,
  });

  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'"],
        manifestSrc: ["'self'"],
        workerSrc: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    strictTransportSecurity: cfg.PUBLIC_BASE_URL.startsWith('https://') ? { maxAge: 31536000, includeSubDomains: true } : false,
  });
  // Must be added before the rate-limit plugin so its own onRoute hook sees the scaled values.
  app.addHook('onRoute', (route) => {
    const rl = (route.config as { rateLimit?: { max?: number } } | undefined)?.rateLimit;
    if (rl?.max) rl.max = Math.ceil(rl.max * cfg.RATE_LIMIT_SCALE);
  });
  await app.register(rateLimit, { max: Math.ceil(600 * cfg.RATE_LIMIT_SCALE), timeWindow: '1 minute', allowList: (req) => req.url === '/healthz',
    // Kiosks behind one restaurant router share an IP: bucket them by device token instead.
    keyGenerator: (req) => {
      const auth = req.headers.authorization;
      return auth?.startsWith('Bearer ') ? `dev:${sha256(auth.slice(7)).toString('base64url').slice(0, 22)}` : req.ip;
    },
  });

  installErrorHandler(app);

  // API responses must never be cached by browsers, proxies or the PWA service worker.
  app.addHook('onSend', async (req, reply, payload) => {
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    return payload;
  });

  registerAppRoutes(app, ctx);
  registerAuthRoutes(app, ctx);
  registerKioskRoutes(app, ctx);
  registerEmployeeRoutes(app, ctx);
  registerAttendanceRoutes(app, ctx);
  registerAdminRoutes(app, ctx);
  registerInsightRoutes(app, ctx);
  registerPayrollRoutes(app, ctx);

  const webDir = cfg.WEB_DIST_DIR ? path.resolve(cfg.WEB_DIST_DIR) : null;
  if (webDir && existsSync(path.join(webDir, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: webDir,
      // Serve files present on disk at request time, so a new build works without a restart.
      wildcard: true,
      cacheControl: false, // headers are set explicitly in setHeaders below
      setHeaders(res, filePath) {
        const base = path.basename(filePath);
        if (base === 'index.html' || base === 'sw.js' || base === 'manifest.webmanifest' || base.startsWith('workbox-')) {
          res.setHeader('Cache-Control', 'no-cache');
        } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        } else {
          res.setHeader('Cache-Control', 'public, max-age=3600');
        }
      },
    });
    app.setNotFoundHandler((req, reply) => {
      // Never answer a missing hashed asset with index.html (that causes MIME errors after deploys).
      if (req.method === 'GET' && !req.url.startsWith('/api/') && !req.url.startsWith('/assets/') && !/\.[a-z0-9]{2,5}(\?|$)/i.test(req.url)) {
        reply.header('Cache-Control', 'no-cache');
        return reply.sendFile('index.html');
      }
      return reply.status(404).send({ error: 'not_found', message: 'Not found' });
    });
  } else {
    app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: 'not_found', message: 'Not found' }));
  }

  const worker = new Worker(db, cfg, mailer);
  return {
    app,
    ctx,
    worker,
    close: async () => {
      worker.stop();
      await app.close();
      await hub.stop();
      await db.end();
    },
  };
}
