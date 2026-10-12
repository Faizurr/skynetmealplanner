import pg from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Return timestamptz as JS Date (default), bigint counts as numbers, numerics as numbers.
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));
// `date` columns stay as YYYY-MM-DD strings (no implicit timezone shift).
pg.types.setTypeParser(1082, (v) => v);

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

export function createPool(url: string, ssl: boolean, max = 10): Db {
  const pool = new pg.Pool({
    connectionString: url,
    max,
    ssl: ssl ? { rejectUnauthorized: true } : undefined,
    idleTimeoutMillis: 30_000,
  });
  pool.on('error', (err) => console.error('[db] idle client error', err.message));
  return pool;
}

/** Runs fn in a transaction without tenant context (auth tables, global tables). */
export async function withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Runs fn in a transaction scoped to one restaurant. Row-level security policies use
 * app.restaurant_id, so even a query that forgets its WHERE restaurant_id clause cannot
 * read or write another tenant's rows (when connected as the non-owner app role).
 */
export async function withTenant<T>(db: Db, restaurantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withTx(db, async (tx) => {
    await tx.query(`SELECT set_config('app.restaurant_id', $1, true)`, [restaurantId]);
    return fn(tx);
  });
}

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export async function migrate(url: string, ssl: boolean, appRole?: string, log = console.log): Promise<string[]> {
  const pool = createPool(url, ssl, 1);
  const applied: string[] = [];
  try {
    await withTx(pool, async (tx) => {
      // Serialize concurrent migrators (e.g. two instances booting at once).
      await tx.query('SELECT pg_advisory_xact_lock(727274)');
      await tx.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
      const done = new Set((await tx.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
      const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
      for (const f of files) {
        if (done.has(f)) continue;
        log(`[migrate] applying ${f}`);
        await tx.query(await readFile(path.join(MIGRATIONS_DIR, f), 'utf8'));
        await tx.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
        applied.push(f);
      }
      if (appRole) {
        // Least privilege for the runtime role: DML only, no DDL, no TRUNCATE.
        await tx.query(`GRANT USAGE ON SCHEMA public TO ${appRole}`);
        await tx.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${appRole}`);
        await tx.query(`REVOKE UPDATE, DELETE ON audit_logs FROM ${appRole}`);
        await tx.query(`REVOKE DELETE ON attendance_events FROM ${appRole}`);
        await tx.query(`REVOKE INSERT, UPDATE, DELETE ON schema_migrations FROM ${appRole}`);
        await tx.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${appRole}`);
        await tx.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${appRole}`);
      }
    });
  } finally {
    await pool.end();
  }
  return applied;
}

/** Warn loudly if the runtime role bypasses RLS (owner/superuser), since isolation then relies on app code only. */
export async function checkRlsPosture(db: Db): Promise<{ enforced: boolean; reason?: string }> {
  const r = await db.query<{ rolsuper: boolean; rolbypassrls: boolean; owns: boolean }>(`
    SELECT r.rolsuper, r.rolbypassrls,
           EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'attendance_events' AND tableowner = current_user) AS owns
    FROM pg_roles r WHERE r.rolname = current_user`);
  const row = r.rows[0];
  if (!row) return { enforced: false, reason: 'role not found' };
  if (row.rolsuper) return { enforced: false, reason: 'connected as superuser' };
  if (row.rolbypassrls) return { enforced: false, reason: 'role has BYPASSRLS' };
  if (row.owns) return { enforced: false, reason: 'connected as table owner' };
  return { enforced: true };
}
