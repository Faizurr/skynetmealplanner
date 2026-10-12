import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeDuration, computeLateness, occurrencesFor, resolveShiftForCheckIn, claimKey, type ShiftDef } from '../src/shifts.js';
import { zonedToUtc, localDate, toLocalParts, formatDuration, addDays } from '../src/time.js';
import { identify, decodeEmbedding, encodeEmbedding } from '../src/face.js';
import { TemplateCipher, hashSecret, verifySecret, normalizePairingCode, newPairingCode } from '../src/crypto.js';
import { resolveSettings, roundMinutes } from '../src/settings.js';
import { quietHoursRelease, isEnabled, escapeHtml, renderEmail } from '../src/notifications.js';
import { csvCell } from '../src/routes/insights.js';
import { backoffMs } from '../src/worker.js';
import { randomIdentity, sampleOf } from './helpers.js';
import { randomBytes } from 'node:crypto';

const KL = 'Asia/Kuala_Lumpur';
const defaults = resolveSettings({});

function shift(p: Partial<ShiftDef> = {}): ShiftDef {
  return {
    id: 's1', name: 'Day', start_time: '09:00', end_time: '18:00', days_of_week: [1, 2, 3, 4, 5, 6, 7],
    grace_minutes: 5, unpaid_break_minutes: 60, break_applies_after_minutes: 360, overtime_after_minutes: null, ...p,
  };
}

test('time: Kuala Lumpur wall clock converts to UTC (+08:00, no DST)', () => {
  assert.equal(zonedToUtc('2026-10-12', '09:00', KL).toISOString(), '2026-10-12T01:00:00.000Z');
  assert.equal(localDate(new Date('2026-10-12T17:30:00Z'), KL), '2026-10-13');
  assert.equal(toLocalParts(new Date('2026-10-12T01:02:00Z'), KL).hour, 9);
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(formatDuration(546), '9h 06m');
});

test('time: DST zone converts correctly across transitions', () => {
  // New York: 2026-03-08 DST starts; 09:00 is EDT (UTC-4) that day.
  assert.equal(zonedToUtc('2026-03-08', '09:00', 'America/New_York').toISOString(), '2026-03-08T13:00:00.000Z');
  assert.equal(zonedToUtc('2026-03-07', '09:00', 'America/New_York').toISOString(), '2026-03-07T14:00:00.000Z');
});

test('shifts: lateness respects grace period', () => {
  const s = shift();
  const occ = { shift: s, start: zonedToUtc('2026-10-12', '09:00', KL), end: zonedToUtc('2026-10-12', '18:00', KL), localDate: '2026-10-12' };
  assert.deepEqual(computeLateness(zonedToUtc('2026-10-12', '09:05', KL), occ), { lateMinutes: 5, isLate: false });
  assert.deepEqual(computeLateness(zonedToUtc('2026-10-12', '09:06', KL), occ), { lateMinutes: 6, isLate: true });
  assert.deepEqual(computeLateness(zonedToUtc('2026-10-12', '08:40', KL), occ), { lateMinutes: 0, isLate: false });
  assert.deepEqual(computeLateness(new Date(), null), { lateMinutes: 0, isLate: false });
});

test('shifts: overnight shift crossing midnight resolves to the previous day start', () => {
  const night = shift({ id: 'n', name: 'Night', start_time: '22:00', end_time: '06:00', days_of_week: [1] }); // Mondays only
  const a = [{ shift: night, effective_from: '2026-01-01', effective_to: null }];
  // Monday 2026-10-12 22:00 → Tuesday 06:00 local.
  const occ = occurrencesFor(a, ['2026-10-12'], KL)[0];
  assert.equal(occ.start.toISOString(), '2026-10-12T14:00:00.000Z');
  assert.equal(occ.end.toISOString(), '2026-10-12T22:00:00.000Z');
  // Check-in at 22:10 Monday is late by 10 min.
  const r = resolveShiftForCheckIn(zonedToUtc('2026-10-12', '22:10', KL), a, KL, 180)!;
  assert.equal(r.shift.id, 'n');
  assert.equal(computeLateness(zonedToUtc('2026-10-12', '22:10', KL), r).lateMinutes, 10);
  // A check-in at 01:00 Tuesday still belongs to Monday's night shift.
  const r2 = resolveShiftForCheckIn(zonedToUtc('2026-10-13', '01:00', KL), a, KL, 180)!;
  assert.equal(r2.localDate, '2026-10-12');
  // Duration across midnight: 22:00 → 06:30 = 8h30 raw, minus 60 break = 7h30 worked; scheduled 8h-1h = 7h → 30 min overtime.
  const d = computeDuration(zonedToUtc('2026-10-12', '22:00', KL), zonedToUtc('2026-10-13', '06:30', KL), night, occ, defaults);
  assert.deepEqual(d, { rawMinutes: 510, breakMinutes: 60, workedMinutes: 450, overtimeMinutes: 30 });
});

test('shifts: multiple shifts per day — second check-in attaches to the next unclaimed shift', () => {
  const lunch = shift({ id: 'L', name: 'Lunch', start_time: '11:00', end_time: '15:00', unpaid_break_minutes: 0 });
  const dinner = shift({ id: 'D', name: 'Dinner', start_time: '17:00', end_time: '22:00', unpaid_break_minutes: 0 });
  const a = [lunch, dinner].map((s) => ({ shift: s, effective_from: '2026-01-01', effective_to: null }));
  const first = resolveShiftForCheckIn(zonedToUtc('2026-10-12', '10:55', KL), a, KL, 180)!;
  assert.equal(first.shift.id, 'L');
  const claimed = new Set([claimKey(first.shift.id, first.start)]);
  const second = resolveShiftForCheckIn(zonedToUtc('2026-10-12', '16:50', KL), a, KL, 180, claimed)!;
  assert.equal(second.shift.id, 'D');
  // Without claim tracking, 14:30 (inside lunch) would map to lunch; with lunch claimed it maps to dinner (early).
  const third = resolveShiftForCheckIn(zonedToUtc('2026-10-12', '14:30', KL), a, KL, 180, claimed)!;
  assert.equal(third.shift.id, 'D');
});

test('shifts: no matching schedule → unscheduled (no lateness)', () => {
  const s = shift({ days_of_week: [6, 7] }); // weekends
  const a = [{ shift: s, effective_from: '2026-01-01', effective_to: null }];
  assert.equal(resolveShiftForCheckIn(zonedToUtc('2026-10-12', '09:30', KL), a, KL, 180), null); // Monday
  // Effective dates are honoured.
  const b = [{ shift: shift(), effective_from: '2026-11-01', effective_to: null }];
  assert.equal(resolveShiftForCheckIn(zonedToUtc('2026-10-12', '09:30', KL), b, KL, 180), null);
});

test('shifts: break only deducted once the threshold is reached; default overtime threshold for unscheduled', () => {
  const s = shift({ unpaid_break_minutes: 60, break_applies_after_minutes: 360 });
  const occ = { start: zonedToUtc('2026-10-12', '09:00', KL), end: zonedToUtc('2026-10-12', '18:00', KL) };
  const short = computeDuration(zonedToUtc('2026-10-12', '09:00', KL), zonedToUtc('2026-10-12', '14:00', KL), s, occ, defaults);
  assert.equal(short.breakMinutes, 0);
  assert.equal(short.workedMinutes, 300);
  const full = computeDuration(zonedToUtc('2026-10-12', '09:02', KL), zonedToUtc('2026-10-12', '18:08', KL), s, occ, defaults);
  assert.deepEqual(full, { rawMinutes: 546, breakMinutes: 60, workedMinutes: 486, overtimeMinutes: 6 });
  const unsched = computeDuration(new Date('2026-10-12T00:00:00Z'), new Date('2026-10-12T09:00:00Z'), null, null, defaults);
  assert.deepEqual(unsched, { rawMinutes: 540, breakMinutes: 0, workedMinutes: 540, overtimeMinutes: 60 });
});

test('settings: invalid keys fall back to defaults individually; rounding modes', () => {
  const s = resolveSettings({ match_threshold: 5, success_return_seconds: 7 });
  assert.equal(s.match_threshold, 0.5);
  assert.equal(s.success_return_seconds, 7);
  assert.equal(roundMinutes(487, 15, 'nearest'), 480);
  assert.equal(roundMinutes(487, 15, 'up'), 495);
  assert.equal(roundMinutes(487, 15, 'down'), 480);
  assert.equal(roundMinutes(487, 0, 'down'), 487);
});

test('face: identify accepts a clear match, rejects unknowns and ambiguous matches (never guesses)', () => {
  const alice = randomIdentity();
  const bob = randomIdentity();
  const sets = [
    { employeeId: 'alice', vectors: [sampleOf(alice), sampleOf(alice)] },
    { employeeId: 'bob', vectors: [sampleOf(bob)] },
  ];
  const ok = identify(sampleOf(alice), sets, 0.5, 0.06);
  assert.equal(ok.accepted, true);
  assert.equal(ok.employeeId, 'alice');
  const unknown = identify(randomIdentity(), sets, 0.5, 0.06);
  assert.equal(unknown.accepted, false);
  assert.equal(unknown.reason, 'below_threshold');
  // Twins: two employees with near-identical templates → ambiguous.
  const twin = [{ employeeId: 'a', vectors: [sampleOf(alice, 0.05)] }, { employeeId: 'b', vectors: [sampleOf(alice, 0.05)] }];
  const amb = identify(sampleOf(alice, 0.05), twin, 0.5, 0.06);
  assert.equal(amb.accepted, false);
  assert.equal(amb.reason, 'ambiguous');
  assert.equal(identify(sampleOf(alice), [], 0.5, 0.06).reason, 'no_templates');
});

test('face: embedding codec round-trips and rejects malformed input', () => {
  const v = randomIdentity();
  const back = decodeEmbedding(encodeEmbedding(v));
  for (let i = 0; i < v.length; i++) assert.ok(Math.abs(back[i] - v[i]) < 1e-6);
  assert.throws(() => decodeEmbedding(Buffer.alloc(10).toString('base64')));
  const nan = Buffer.alloc(512);
  nan.writeFloatLE(NaN, 0);
  assert.throws(() => decodeEmbedding(nan.toString('base64')));
});

test('crypto: template encryption is authenticated and bound to the employee', () => {
  const c = new TemplateCipher(new Map([[1, randomBytes(32)]]), 1);
  const blob = c.encrypt(Buffer.from('secret-template'), 'r1:e1');
  assert.equal(c.decrypt(blob, 'r1:e1').toString(), 'secret-template');
  assert.throws(() => c.decrypt(blob, 'r1:e2'), 'swapping rows between employees must fail');
  blob.ciphertext[0] ^= 1;
  assert.throws(() => c.decrypt(blob, 'r1:e1'), 'tampering must fail');
});

test('crypto: scrypt password hashing and pairing code normalisation', async () => {
  const h = await hashSecret('1234');
  assert.equal(await verifySecret('1234', h), true);
  assert.equal(await verifySecret('4321', h), false);
  assert.equal(await verifySecret('x', null), false);
  const code = newPairingCode();
  assert.match(code, /^[A-Z2-9]{3}-[A-Z2-9]{3}-[A-Z2-9]{3}$/);
  assert.equal(normalizePairingCode(code.toLowerCase().replace(/-/g, ' ')), code);
});

test('notifications: quiet hours (wrapping midnight), important-only filter, HTML escaping', () => {
  const base = {
    emails: ['o@test.invalid'], on_check_in: true, on_check_out: true, important_only: false, late_arrival: true, missing_checkout: true,
    unknown_face: true, suspicious_events: true, device_offline: true, sync_failure: true, daily_summary: true, daily_summary_time: '22:00',
    quiet_hours_start: '22:00', quiet_hours_end: '07:00', include_staff_id: true,
  };
  const at2330 = zonedToUtc('2026-10-12', '23:30', KL);
  assert.equal(quietHoursRelease(base, at2330, KL)?.toISOString(), zonedToUtc('2026-10-13', '07:00', KL).toISOString());
  const at0300 = zonedToUtc('2026-10-13', '03:00', KL);
  assert.equal(quietHoursRelease(base, at0300, KL)?.toISOString(), zonedToUtc('2026-10-13', '07:00', KL).toISOString());
  assert.equal(quietHoursRelease(base, zonedToUtc('2026-10-13', '12:00', KL), KL), null);
  assert.equal(isEnabled({ ...base, important_only: true }, 'check_in'), false);
  assert.equal(isEnabled({ ...base, important_only: true }, 'late_arrival'), true);
  assert.equal(isEnabled({ ...base, emails: [] }, 'late_arrival'), false);
  assert.equal(escapeHtml('<script>"x"</script>'), '&lt;script&gt;&quot;x&quot;&lt;/script&gt;');
  const e = renderEmail({ restaurantName: 'R', heading: 'H <b>', rows: [['Employee', '<img src=x>']] });
  assert.ok(!e.html.includes('<img'), 'no injected markup / images in emails');
});

test('csv: formula injection neutralised and quoting applied', () => {
  assert.equal(csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell(null), '');
});

test('worker: exponential backoff is capped at 60 minutes', () => {
  assert.equal(backoffMs(1), 60_000);
  assert.equal(backoffMs(3), 240_000);
  assert.equal(backoffMs(20), 3_600_000);
});
