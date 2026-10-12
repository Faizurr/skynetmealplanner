/**
 * Generates core/src/test/resources/server-parity.json from the REAL server implementation
 * (server/src/face.ts: encodeEmbedding / decodeEmbedding / identify) so the kiosk's Kotlin
 * matcher and codec are tested for exact parity.
 *
 *   cd attendance/server && npx tsx ../android/tools/gen-server-parity.ts
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { decodeEmbedding, encodeEmbedding, identify, normalize, EMBEDDING_DIM } from '../../server/src/face.js';

let seed = 1234567;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
const randVec = () => normalize(Float32Array.from({ length: EMBEDDING_DIM }, gauss));
const mix = (parts: [Float32Array, number][], noise: number) =>
  normalize(Float32Array.from({ length: EMBEDDING_DIM }, (_, i) => parts.reduce((s, [v, w]) => s + v[i] * w, 0) + gauss() * noise));

const cases: unknown[] = [];
const settings = [[0.5, 0.06], [0.5, 0.0], [0.363, 0.06], [0.6, 0.1]];
for (let c = 0; c < 240; c++) {
  const nEmp = c % 25 === 0 ? 0 : 1 + Math.floor(rand() * 5);
  const emps = Array.from({ length: nEmp }, (_, i) => {
    const base = randVec();
    const n = 1 + Math.floor(rand() * 3);
    return { employeeId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, base, vectors: Array.from({ length: n }, () => mix([[base, 1]], 0.06 + rand() * 0.06)) };
  });
  let probe: Float32Array;
  if (nEmp === 0 || rand() < 0.2) probe = randVec();
  else {
    const a = emps[Math.floor(rand() * nEmp)];
    const b = emps[Math.floor(rand() * nEmp)];
    if ((c % 4 === 2 || c % 8 === 0) && nEmp > 1) {
      // Near-equal blend of two different employees: exercises the margin (ambiguous) rule.
      const other = emps[(emps.indexOf(a) + 1) % nEmp];
      const w = 0.8 + rand() * 0.4;
      probe = mix([[a.base, w], [other.base, w + (rand() - 0.5) * 0.15]], 0.02);
    } else {
      probe = mix([[a.base, 0.3 + rand()], [b.base, rand() * 0.9]], 0.04 + rand() * 0.1);
    }
  }
  // Round-trip through the wire format exactly as the kiosk/server do.
  const probeB64 = encodeEmbedding(probe);
  const probeDecoded = decodeEmbedding(probeB64);
  const sets = emps.map((e) => ({ employeeId: e.employeeId, vectors: e.vectors.map((v) => decodeEmbedding(encodeEmbedding(v))) }));
  const [threshold, margin] = settings[c % settings.length];
  const m = identify(probeDecoded, sets, threshold, margin);
  cases.push({
    threshold, margin,
    probe: probeB64,
    employees: emps.map((e) => ({ id: e.employeeId, templates: e.vectors.map(encodeEmbedding) })),
    expected: { employee_id: m.employeeId, score: m.score, second_employee_id: m.secondEmployeeId, second_score: m.secondScore, accepted: m.accepted, reason: m.reason ?? null },
  });
}

// Codec fixture: a known vector and its server encoding.
const known = Float32Array.from({ length: EMBEDDING_DIM }, (_, i) => Math.sin(i + 1) * (i % 3 === 0 ? -1 : 1));
const out = {
  generated_by: 'android/tools/gen-server-parity.ts',
  codec: { values: Array.from(known), encoded: encodeEmbedding(known), decoded_normalized: Array.from(decodeEmbedding(encodeEmbedding(known))) },
  cases,
};
const here = dirname(fileURLToPath(import.meta.url));
writeFileSync(join(here, '..', 'core', 'src', 'test', 'resources', 'server-parity.json'), JSON.stringify(out));
const counts = cases.reduce((acc: Record<string, number>, c: any) => ((acc[c.expected.accepted ? 'accepted' : c.expected.reason] = (acc[c.expected.accepted ? 'accepted' : c.expected.reason] ?? 0) + 1), acc), {});
console.log('cases', cases.length, counts);
