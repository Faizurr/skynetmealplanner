import type { Db, Tx } from './db.js';
import { withTenant } from './db.js';
import type { TemplateCipher } from './crypto.js';

/** Recognition model identifier. Embeddings from different models are not comparable. */
export const FACE_MODEL = 'opencv-sface-2021dec';
export const EMBEDDING_DIM = 128;

export function decodeEmbedding(b64: string): Float32Array {
  const buf = Buffer.from(b64, 'base64');
  if (buf.length !== EMBEDDING_DIM * 4) throw new Error(`embedding must be ${EMBEDDING_DIM} float32 values`);
  const out = new Float32Array(EMBEDDING_DIM);
  for (let i = 0; i < EMBEDDING_DIM; i++) {
    const v = buf.readFloatLE(i * 4);
    if (!Number.isFinite(v)) throw new Error('embedding contains non-finite values');
    out[i] = v;
  }
  return normalize(out);
}

export function encodeEmbedding(v: Float32Array): string {
  const buf = Buffer.alloc(v.length * 4);
  v.forEach((x, i) => buf.writeFloatLE(x, i * 4));
  return buf.toString('base64');
}

export function normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n);
  if (n === 0) throw new Error('zero embedding');
  return v.map((x) => x / n) as Float32Array;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export interface TemplateSet {
  employeeId: string;
  vectors: Float32Array[];
}

export interface MatchResult {
  employeeId: string | null;
  score: number;
  secondEmployeeId: string | null;
  secondScore: number;
  accepted: boolean;
  reason?: 'no_templates' | 'below_threshold' | 'ambiguous';
}

/**
 * 1:N identification. Per-employee score = best cosine across that employee's templates.
 * Accept only if best >= threshold AND best - bestOtherEmployee >= margin. Never guesses.
 */
export function identify(probe: Float32Array, sets: TemplateSet[], threshold: number, margin: number): MatchResult {
  let best = { id: null as string | null, s: -1 };
  let second = { id: null as string | null, s: -1 };
  for (const set of sets) {
    let s = -1;
    for (const v of set.vectors) s = Math.max(s, cosine(probe, v));
    if (s > best.s) {
      second = best;
      best = { id: set.employeeId, s };
    } else if (s > second.s) second = { id: set.employeeId, s };
  }
  const result: MatchResult = {
    employeeId: best.id,
    score: best.s,
    secondEmployeeId: second.id,
    secondScore: second.s,
    accepted: false,
  };
  if (!best.id) return { ...result, reason: 'no_templates' };
  if (best.s < threshold) return { ...result, reason: 'below_threshold' };
  if (second.id && best.s - second.s < margin) return { ...result, reason: 'ambiguous' };
  return { ...result, accepted: true };
}

/** Decrypted active templates per restaurant, cached briefly and invalidated on enrollment changes. */
export class TemplateStore {
  private cache = new Map<string, { at: number; sets: TemplateSet[] }>();
  constructor(
    private readonly db: Db,
    private readonly cipher: TemplateCipher,
    private readonly ttlMs = 60_000,
  ) {}

  invalidate(restaurantId: string) {
    this.cache.delete(restaurantId);
  }

  async get(restaurantId: string, tx?: Tx): Promise<TemplateSet[]> {
    const hit = this.cache.get(restaurantId);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.sets;
    const load = async (q: Tx) => {
      const r = await q.query<{
        employee_id: string;
        key_version: number;
        iv: Buffer;
        ciphertext: Buffer;
        auth_tag: Buffer;
      }>(
        `SELECT t.employee_id, t.key_version, t.iv, t.ciphertext, t.auth_tag
           FROM face_templates t
           JOIN face_enrollments e ON e.id = t.enrollment_id
           JOIN employees emp ON emp.id = t.employee_id
          WHERE t.restaurant_id = $1 AND e.status = 'active' AND emp.status = 'active'`,
        [restaurantId],
      );
      const byEmp = new Map<string, Float32Array[]>();
      for (const row of r.rows) {
        const plain = this.cipher.decrypt(
          { keyVersion: row.key_version, iv: row.iv, ciphertext: row.ciphertext, authTag: row.auth_tag },
          `${restaurantId}:${row.employee_id}`,
        );
        const v = new Float32Array(EMBEDDING_DIM);
        for (let i = 0; i < EMBEDDING_DIM; i++) v[i] = plain.readFloatLE(i * 4);
        const list = byEmp.get(row.employee_id) ?? [];
        list.push(v);
        byEmp.set(row.employee_id, list);
      }
      return [...byEmp.entries()].map(([employeeId, vectors]) => ({ employeeId, vectors }));
    };
    const sets = tx ? await load(tx) : await withTenant(this.db, restaurantId, load);
    this.cache.set(restaurantId, { at: Date.now(), sets });
    return sets;
  }
}
