import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(8080),
  HOST: z.string().default('0.0.0.0'),
  /** Public HTTPS origin of the dashboard, used for links in emails and cookie security. */
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:8080'),
  /** Connection string for the application role (subject to row-level security). */
  DATABASE_URL: z.string().min(1),
  /** Connection string for the owner/migration role. Defaults to DATABASE_URL. */
  MIGRATION_DATABASE_URL: z.string().optional(),
  /** Role that the app connects as; migrations GRANT it the privileges it needs. */
  APP_DB_ROLE: z.string().regex(/^[a-z_][a-z0-9_]*$/).optional(),
  DATABASE_SSL: bool.default('false'),
  /**
   * 32-byte key (base64) for AES-256-GCM encryption of face templates. Rotate by adding
   * a new version: TEMPLATE_KEYS="2:base64key,1:oldbase64key" (first = current).
   */
  TEMPLATE_KEYS: z.string().min(1),
  SIGNUP_ENABLED: bool.default('true'),
  RUN_WORKER: bool.default('true'),
  WEB_DIST_DIR: z.string().optional(),
  TRUST_PROXY: bool.default('false'),
  /** Multiplies every per-route rate limit (tests use a large value). */
  RATE_LIMIT_SCALE: z.coerce.number().positive().default(1),

  // Email
  EMAIL_TRANSPORT: z.enum(['smtp', 'resend', 'log', 'disabled']).default('log'),
  EMAIL_FROM: z.string().default('Attendance <attendance@example.com>'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().optional(),
  SMTP_SECURE: bool.optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_IGNORE_TLS: bool.default('false'),
  RESEND_API_KEY: z.string().optional(),

  // Worker cadence
  WORKER_INTERVAL_MS: z.coerce.number().int().default(20_000),
  DEVICE_OFFLINE_MINUTES: z.coerce.number().int().default(15),
});

export type Config = z.infer<typeof schema> & { templateKeys: Map<number, Buffer>; currentKeyVersion: number };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n  ');
    throw new Error(`Invalid configuration:\n  ${issues}`);
  }
  const cfg = parsed.data;
  const templateKeys = new Map<number, Buffer>();
  let currentKeyVersion = 0;
  for (const [idx, part] of cfg.TEMPLATE_KEYS.split(',').entries()) {
    const m = /^(\d+):(.+)$/.exec(part.trim());
    const version = m ? Number(m[1]) : 1;
    const key = Buffer.from(m ? m[2] : part.trim(), 'base64');
    if (key.length !== 32) throw new Error(`TEMPLATE_KEYS entry ${idx} must decode to exactly 32 bytes`);
    templateKeys.set(version, key);
    if (idx === 0) currentKeyVersion = version;
  }
  if (cfg.NODE_ENV === 'production') {
    if (!cfg.PUBLIC_BASE_URL.startsWith('https://')) throw new Error('PUBLIC_BASE_URL must be https:// in production');
    if (cfg.EMAIL_TRANSPORT === 'smtp' && !cfg.SMTP_HOST) throw new Error('SMTP_HOST is required for EMAIL_TRANSPORT=smtp');
    if (cfg.EMAIL_TRANSPORT === 'resend' && !cfg.RESEND_API_KEY) throw new Error('RESEND_API_KEY is required for EMAIL_TRANSPORT=resend');
  }
  return { ...cfg, templateKeys, currentKeyVersion };
}
