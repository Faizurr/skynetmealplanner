/**
 * Integration test harness. Uses a REAL PostgreSQL database with two roles:
 *   att_owner — owns the schema, runs migrations
 *   att_app   — the runtime role, subject to row-level security
 * Requires TEST_PG_ADMIN_URL (a superuser URL, default postgres://postgres@localhost:5432/postgres).
 * All data created here are clearly-labelled TEST FIXTURES.
 */
import pg from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';
import { loadConfig, type Config } from '../src/config.js';
import { migrate } from '../src/db.js';
import { buildApp, type BuiltApp } from '../src/app.js';
import { encodeEmbedding, EMBEDDING_DIM } from '../src/face.js';

const ADMIN_URL = process.env.TEST_PG_ADMIN_URL ?? 'postgres://postgres@localhost:5432/postgres';
const TEST_KEY = randomBytes(32).toString('base64');

export async function freshDatabase(name: string): Promise<{ ownerUrl: string; appUrl: string }> {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  for (const [role, pass] of [['att_owner', 'owner_pw'], ['att_app', 'app_pw']]) {
    const exists = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
    if (!exists.rowCount) await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${pass}'`);
  }
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${name} OWNER att_owner`);
  await admin.end();
  const u = new URL(ADMIN_URL);
  const base = `${u.hostname}:${u.port || 5432}/${name}`;
  const ownerUrl = `postgres://att_owner:owner_pw@${base}`;
  const appUrl = `postgres://att_app:app_pw@${base}`;
  // pgcrypto must be created by a superuser on some installs.
  const su = new pg.Client({ connectionString: `${ADMIN_URL.replace(/\/[^/]*$/, '')}/${name}` });
  await su.connect();
  await su.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  await su.end();
  await migrate(ownerUrl, false, 'att_app', () => {});
  return { ownerUrl, appUrl };
}

export function testConfig(appUrl: string, extra: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: appUrl,
    TEMPLATE_KEYS: `1:${TEST_KEY}`,
    PUBLIC_BASE_URL: 'http://localhost:8080',
    EMAIL_TRANSPORT: 'log',
    RUN_WORKER: 'false',
    RATE_LIMIT_SCALE: '100',
    ...extra,
  } as NodeJS.ProcessEnv);
}

export interface Harness {
  built: BuiltApp;
  owner: pg.Client; // owner-role connection for fixtures/assertions (bypasses RLS)
  close: () => Promise<void>;
}

export async function startHarness(dbName: string, extra: Record<string, string> = {}): Promise<Harness> {
  const { ownerUrl, appUrl } = await freshDatabase(dbName);
  const built = await buildApp(testConfig(appUrl, extra), { logger: false });
  await built.app.ready();
  const owner = new pg.Client({ connectionString: ownerUrl });
  await owner.connect();
  return {
    built,
    owner,
    close: async () => {
      await owner.end();
      await built.close();
    },
  };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
export class WebClient {
  cookie = '';
  constructor(private h: Harness) {}

  async req(method: string, url: string, body?: unknown) {
    const res = await this.h.built.app.inject({
      method: method as 'GET',
      url,
      payload: body === undefined ? undefined : (body as object),
      headers: { cookie: this.cookie, 'x-csrf': '1' },
    });
    const sc = res.headers['set-cookie'];
    if (sc) {
      const first = Array.isArray(sc) ? sc[0] : sc;
      this.cookie = first.split(';')[0];
    }
    let json: any = null;
    try {
      json = res.json();
    } catch {
      /* non-json */
    }
    return { status: res.statusCode, json, body: res.body, headers: res.headers };
  }
  get = (url: string) => this.req('GET', url);
  post = (url: string, body: unknown = {}) => this.req('POST', url, body);
  put = (url: string, body: unknown = {}) => this.req('PUT', url, body);
  patch = (url: string, body: unknown = {}) => this.req('PATCH', url, body);
  del = (url: string) => this.req('DELETE', url);
}

export class KioskClient {
  token = '';
  managerToken = '';
  constructor(private h: Harness) {}
  async req(method: string, url: string, body?: unknown) {
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}` };
    if (this.managerToken) headers['x-manager-token'] = this.managerToken;
    const res = await this.h.built.app.inject({ method: method as 'GET', url, payload: body as object, headers });
    let json: any = null;
    try {
      json = res.json();
    } catch {
      /* empty */
    }
    return { status: res.statusCode, json, headers: res.headers };
  }
  get = (url: string) => this.req('GET', url);
  post = (url: string, body: unknown = {}) => this.req('POST', url, body);
}

export async function signupOwner(h: Harness, label: string) {
  const web = new WebClient(h);
  const email = `owner-${label}-${randomUUID().slice(0, 6)}@test.invalid`;
  const res = await web.post('/api/auth/signup', {
    restaurant_name: `TEST FIXTURE ${label} Restaurant`,
    full_name: `Test Owner ${label}`,
    email,
    password: 'correct-horse-battery',
  });
  if (res.status !== 201) throw new Error(`signup failed: ${res.status} ${res.body}`);
  const me = await web.get('/api/auth/me');
  return { web, email, password: 'correct-horse-battery', restaurantId: me.json.restaurant.id as string };
}

export async function pairKiosk(h: Harness, web: WebClient, name = 'Front door kiosk') {
  const created = await web.post('/api/devices', { name });
  if (created.status !== 201) throw new Error(`device create failed ${created.body}`);
  const kiosk = new KioskClient(h);
  const paired = await kiosk.post('/api/kiosk/pair', { code: created.json.pairing_code.toLowerCase().replace(/-/g, ' '), device_model: 'TEST', app_version: '1.0.0' });
  if (paired.status !== 200) throw new Error(`pair failed ${JSON.stringify(paired.json)}`);
  kiosk.token = paired.json.device_token;
  return { kiosk, deviceId: paired.json.device_id as string };
}

export async function managerLogin(kiosk: KioskClient, email: string, password: string) {
  const r = await kiosk.post('/api/kiosk/manager/login', { email, password });
  if (r.status !== 200) throw new Error(`manager login failed ${JSON.stringify(r.json)}`);
  kiosk.managerToken = r.json.manager_token;
}

// ---------------------------------------------------------------------------
// Synthetic embeddings for API tests. These exercise the server's matching logic
// with controlled similarity; the real SFace pipeline is validated in tools/face-eval.
// ---------------------------------------------------------------------------
function gaussian(): number {
  const u = 1 - Math.random();
  const v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function randomIdentity(): Float32Array {
  const v = new Float32Array(EMBEDDING_DIM);
  for (let i = 0; i < v.length; i++) v[i] = gaussian();
  return normalize(v);
}

export function normalize(v: Float32Array): Float32Array {
  const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0));
  return v.map((x) => x / n) as Float32Array;
}

/** A sample of the identity with noise; noise 0.25 gives cosine ≈ 0.95 to the base. */
export function sampleOf(base: Float32Array, noise = 0.25): Float32Array {
  const v = new Float32Array(base.length);
  for (let i = 0; i < v.length; i++) v[i] = base[i] + (noise / Math.sqrt(base.length)) * gaussian();
  return normalize(v);
}

export const b64 = (v: Float32Array) => encodeEmbedding(v);

export async function createEmployee(web: WebClient, fields: Record<string, unknown> = {}) {
  const r = await web.post('/api/employees', { full_name: 'Test Employee', staff_id: `T${Math.floor(Math.random() * 1e6)}`, ...fields });
  if (r.status !== 201) throw new Error(`employee create failed ${r.body}`);
  return r.json.employee;
}

export async function enroll(kiosk: KioskClient, employeeId: string, identity: Float32Array, confirm = true) {
  return kiosk.post('/api/kiosk/manager/enrollments', {
    employee_id: employeeId,
    embeddings: [0, 1, 2, 3, 4].map(() => b64(sampleOf(identity))),
    consent: { confirmed: true, method: 'written_form', notice_version: '2026-10-v1' },
    confirm_identity: confirm,
  });
}

export function faceAttempt(identity: Float32Array | null, action: 'check_in' | 'check_out', extra: Record<string, unknown> = {}) {
  return {
    event_id: randomUUID(),
    action,
    method: 'face',
    embedding: b64(identity ? sampleOf(identity) : randomIdentity()),
    liveness_passed: true,
    device_timestamp: new Date().toISOString(),
    offline: false,
    ...extra,
  };
}
