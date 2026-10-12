import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import {
  startHarness, signupOwner, pairKiosk, managerLogin, createEmployee, enroll, faceAttempt, randomIdentity, sampleOf, b64,
  WebClient, KioskClient, type Harness,
} from './helpers.js';
import { localDate, toLocalParts } from '../src/time.js';

const KL = 'Asia/Kuala_Lumpur';
let h: Harness;

before(async () => {
  h = await startHarness('attendance_it');
});
after(async () => {
  await h?.close();
});

async function count(sql: string, params: unknown[] = []): Promise<number> {
  return Number((await h.owner.query(sql, params)).rows[0].n);
}

/** Shift starting `offsetMin` minutes from now (local KL time), every day. */
function shiftAround(offsetMin: number, lengthMin = 480) {
  const start = new Date(Date.now() + offsetMin * 60_000);
  const end = new Date(start.getTime() + lengthMin * 60_000);
  const p = toLocalParts(start, KL);
  const e = toLocalParts(end, KL);
  const f = (x: { hour: number; minute: number }) => `${String(x.hour).padStart(2, '0')}:${String(x.minute).padStart(2, '0')}`;
  return { start_time: f(p), end_time: f(e), days_of_week: [1, 2, 3, 4, 5, 6, 7] };
}

describe('authentication & authorization', () => {
  test('signup creates restaurant, branch, owner membership and default notification email', async () => {
    const o = await signupOwner(h, 'auth');
    const me = await o.web.get('/api/auth/me');
    assert.equal(me.status, 200);
    assert.equal(me.json.role, 'owner');
    assert.equal(me.json.restaurant.timezone, KL);
    const ns = await o.web.get('/api/notifications/settings');
    assert.deepEqual(ns.json.settings.emails, [o.email]);
  });

  test('wrong password rejected; account locks after repeated failures', async () => {
    const o = await signupOwner(h, 'lock');
    const anon = new WebClient(h);
    const bad = await anon.post('/api/auth/login', { email: o.email, password: 'nope-nope-nope' });
    assert.equal(bad.status, 401);
    for (let i = 0; i < 8; i++) await anon.post('/api/auth/login', { email: o.email, password: 'wrong-wrong-' + i });
    const locked = await anon.post('/api/auth/login', { email: o.email, password: o.password });
    assert.equal(locked.status, 423);
  });

  test('unauthenticated and CSRF-less requests are refused', async () => {
    const anon = new WebClient(h);
    assert.equal((await anon.get('/api/employees')).status, 401);
    const o = await signupOwner(h, 'csrf');
    const res = await h.built.app.inject({ method: 'POST', url: '/api/employees', headers: { cookie: o.web.cookie }, payload: { full_name: 'X', staff_id: 'X1' } });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error, 'csrf');
  });

  test('attendance_admin role cannot manage biometrics, devices or team', async () => {
    const o = await signupOwner(h, 'roles');
    const add = await o.web.post('/api/team', { email: `admin-${randomUUID().slice(0, 6)}@test.invalid`, full_name: 'Attendance Admin', role: 'attendance_admin' });
    assert.equal(add.status, 201);
    assert.ok(add.json.temporary_password);
    const admin = new WebClient(h);
    const members = await o.web.get('/api/team');
    const email = members.json.members.find((m: any) => m.role === 'attendance_admin').email;
    assert.equal((await admin.post('/api/auth/login', { email, password: add.json.temporary_password })).status, 200);
    assert.equal((await admin.get('/api/employees')).status, 200);
    assert.equal((await admin.post('/api/devices', { name: 'x' })).status, 403);
    assert.equal((await admin.get('/api/team')).status, 403);
    const emp = await createEmployee(o.web);
    assert.equal((await admin.del(`/api/employees/${emp.id}/biometrics`)).status, 403);
    assert.equal((await admin.get('/api/enrollments')).status, 403);
    // Last owner cannot be demoted.
    const ownerId = members.json.members.find((m: any) => m.role === 'owner').id;
    assert.equal((await o.web.patch(`/api/team/${ownerId}`, { role: 'manager' })).status, 409);
  });
});

describe('device pairing', () => {
  test('pairing code is single-use; revoked devices are locked out', async () => {
    const o = await signupOwner(h, 'pair');
    const created = await o.web.post('/api/devices', { name: 'Kiosk A' });
    const k = new KioskClient(h);
    const ok = await k.post('/api/kiosk/pair', { code: created.json.pairing_code });
    assert.equal(ok.status, 200);
    const again = await k.post('/api/kiosk/pair', { code: created.json.pairing_code });
    assert.equal(again.status, 400);
    k.token = ok.json.device_token;
    assert.equal((await k.get('/api/kiosk/config')).status, 200);
    await o.web.post(`/api/devices/${ok.json.device_id}/revoke`);
    const after = await k.get('/api/kiosk/config');
    assert.equal(after.status, 401);
    assert.equal((await new KioskClient(h).get('/api/kiosk/config')).status, 401);
  });

  test('expired pairing code is rejected', async () => {
    const o = await signupOwner(h, 'pairexp');
    const created = await o.web.post('/api/devices', { name: 'Kiosk B' });
    await h.owner.query(`UPDATE devices SET pairing_expires_at = now() - interval '1 minute' WHERE id = $1`, [created.json.device_id]);
    const r = await new KioskClient(h).post('/api/kiosk/pair', { code: created.json.pairing_code });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, 'invalid_pairing_code');
  });
});

describe('enrollment', () => {
  test('requires a manager session, consent, consistent samples; prevents one face under two employees', async () => {
    const o = await signupOwner(h, 'enr');
    const { kiosk } = await pairKiosk(h, o.web);
    const sarah = await createEmployee(o.web, { full_name: 'Sarah Lim', staff_id: 'S001' });
    const ali = await createEmployee(o.web, { full_name: 'Ali Hassan', staff_id: 'S002' });
    const face = randomIdentity();

    assert.equal((await enroll(kiosk, sarah.id, face)).status, 401, 'no manager token');
    await managerLogin(kiosk, o.email, o.password);

    const noConsent = await kiosk.post('/api/kiosk/manager/enrollments', {
      employee_id: sarah.id, embeddings: [1, 2, 3].map(() => b64(sampleOf(face))), consent: { confirmed: false, method: 'written_form', notice_version: 'v' }, confirm_identity: true,
    });
    assert.equal(noConsent.status, 400);

    const mixed = await kiosk.post('/api/kiosk/manager/enrollments', {
      employee_id: sarah.id, embeddings: [b64(sampleOf(face)), b64(randomIdentity()), b64(sampleOf(face))],
      consent: { confirmed: true, method: 'written_form', notice_version: '2026-10-v1' }, confirm_identity: true,
    });
    assert.equal(mixed.status, 422);
    assert.equal(mixed.json.error, 'inconsistent_samples');

    const ok = await enroll(kiosk, sarah.id, face);
    assert.equal(ok.status, 200);
    assert.equal(ok.json.status, 'active');

    const dup = await enroll(kiosk, ali.id, face);
    assert.equal(dup.status, 409);
    assert.equal(dup.json.error, 'face_already_enrolled');

    // Templates are stored encrypted; nothing resembling raw floats in plaintext.
    const row = (await h.owner.query('SELECT ciphertext, iv, auth_tag FROM face_templates WHERE employee_id = $1 LIMIT 1', [sarah.id])).rows[0];
    assert.equal(row.ciphertext.length, 512);
    assert.equal(row.iv.length, 12);

    // Re-enrollment replaces old templates.
    const before = await count('SELECT count(*) n FROM face_templates WHERE employee_id = $1', [sarah.id]);
    assert.equal((await enroll(kiosk, sarah.id, face)).status, 200);
    assert.equal(await count('SELECT count(*) n FROM face_templates WHERE employee_id = $1', [sarah.id]), before);
    assert.equal(await count(`SELECT count(*) n FROM face_enrollments WHERE employee_id = $1 AND status = 'revoked'`, [sarah.id]), 1);
  });

  test('pending enrollment is not usable until the owner confirms identity', async () => {
    const o = await signupOwner(h, 'pend');
    const { kiosk } = await pairKiosk(h, o.web);
    await managerLogin(kiosk, o.email, o.password);
    const emp = await createEmployee(o.web, { full_name: 'Pending Person', staff_id: 'P1' });
    const face = randomIdentity();
    const r = await enroll(kiosk, emp.id, face, false);
    assert.equal(r.json.status, 'pending_confirmation');
    const k2 = new KioskClient(h);
    k2.token = kiosk.token;
    const attempt = await k2.post('/api/kiosk/attendance', faceAttempt(face, 'check_in', { employee_id: emp.id }));
    assert.equal(attempt.status, 422);
    assert.equal(attempt.json.error, 'not_recognized');
    const list = await o.web.get('/api/enrollments');
    assert.equal(list.json.enrollments.length, 1);
    assert.equal((await o.web.post(`/api/enrollments/${r.json.enrollment_id}/confirm`)).status, 200);
    const again = await k2.post('/api/kiosk/attendance', faceAttempt(face, 'check_in', { employee_id: emp.id }));
    assert.equal(again.status, 200, JSON.stringify(again.json));
  });
});

describe('attendance state machine', () => {
  let o: Awaited<ReturnType<typeof signupOwner>>;
  let kiosk: KioskClient;
  let kiosk2: KioskClient;
  let sarah: any;
  let face: Float32Array;

  before(async () => {
    o = await signupOwner(h, 'att');
    ({ kiosk } = await pairKiosk(h, o.web, 'Kiosk 1'));
    ({ kiosk: kiosk2 } = await pairKiosk(h, o.web, 'Kiosk 2'));
    await managerLogin(kiosk, o.email, o.password);
    const sh = await o.web.post('/api/shifts', { name: 'Test shift', ...shiftAround(-30), grace_minutes: 5, unpaid_break_minutes: 30 });
    assert.equal(sh.status, 201);
    sarah = await createEmployee(o.web, { full_name: 'Sarah Lim', preferred_name: 'Sarah', staff_id: 'S100', shift_ids: [sh.json.shift.id] });
    face = randomIdentity();
    assert.equal((await enroll(kiosk, sarah.id, face)).status, 200);
    kiosk.managerToken = '';
  });

  test('CHECK IN records exactly one verified event with server time, lateness and greeting', async () => {
    const body = faceAttempt(face, 'check_in', { employee_id: sarah.id });
    const t0 = Date.now();
    const r = await kiosk.post('/api/kiosk/attendance', body);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.result, 'recorded');
    assert.equal(r.json.event.type, 'check_in');
    assert.equal(r.json.event.verification_status, 'verified');
    assert.equal(r.json.employee.full_name, 'Sarah Lim');
    assert.match(r.json.display.greeting, /^Good (morning|afternoon|evening), Sarah!$/);
    assert.equal(r.json.display.headline, 'CHECK-IN SUCCESSFUL');
    assert.ok(Math.abs(Date.parse(r.json.event.event_time) - t0) < 5000, 'server-confirmed timestamp');
    assert.equal(r.json.session.is_late, true);
    assert.ok(r.json.session.late_minutes >= 29 && r.json.session.late_minutes <= 31);
    assert.equal(await count('SELECT count(*) n FROM attendance_events WHERE employee_id = $1', [sarah.id]), 1);
    assert.equal(await count(`SELECT count(*) n FROM attendance_exceptions WHERE employee_id = $1 AND kind = 'late_arrival'`, [sarah.id]), 1);

    // Same event id re-sent (retry / repeated frame) → duplicate, nothing new.
    const dup = await kiosk.post('/api/kiosk/attendance', body);
    assert.equal(dup.status, 200);
    assert.equal(dup.json.result, 'duplicate');
    assert.equal(await count('SELECT count(*) n FROM attendance_events WHERE employee_id = $1', [sarah.id]), 1);
  });

  test('CHECK IN while already checked in is rejected (never converted to check-out)', async () => {
    const r = await kiosk.post('/api/kiosk/attendance', faceAttempt(face, 'check_in', { employee_id: sarah.id }));
    assert.equal(r.status, 409);
    assert.equal(r.json.error, 'already_checked_in');
    assert.equal(await count(`SELECT count(*) n FROM attendance_events WHERE employee_id = $1 AND event_type = 'check_out'`, [sarah.id]), 0);
  });

  test('CHECK OUT immediately after check-in is blocked as too soon', async () => {
    const r = await kiosk.post('/api/kiosk/attendance', faceAttempt(face, 'check_out', { employee_id: sarah.id }));
    assert.equal(r.status, 409);
    assert.equal(r.json.error, 'too_soon');
  });

  test('CHECK OUT closes the session with duration computed from real timestamps and break rules', async () => {
    // Move the session's check-in back 9h06m (test fixture manipulation of the derived session row only).
    await h.owner.query(`UPDATE attendance_sessions SET check_in_at = now() - interval '546 minutes' WHERE employee_id = $1 AND status = 'open'`, [sarah.id]);
    const r = await kiosk2.post('/api/kiosk/attendance', faceAttempt(face, 'check_out', { employee_id: sarah.id }));
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.display.headline, 'CHECK-OUT SUCCESSFUL');
    assert.equal(r.json.session.break_minutes, 30);
    assert.ok([515, 516].includes(r.json.session.worked_minutes), `worked ${r.json.session.worked_minutes}`);
    assert.match(r.json.display.duration, /^8h 3[56]m$/);
    assert.match(r.json.display.greeting, /Sarah/);
  });

  test('CHECK OUT without an active session is rejected', async () => {
    const r = await kiosk.post('/api/kiosk/attendance', faceAttempt(face, 'check_out', { employee_id: sarah.id }));
    assert.equal(r.status, 409);
    assert.equal(r.json.error, 'no_active_session');
  });

  test('unknown face is never assigned to an employee', async () => {
    const before = await count('SELECT count(*) n FROM attendance_events');
    const r = await kiosk.post('/api/kiosk/attendance', faceAttempt(null, 'check_in'));
    assert.equal(r.status, 422);
    assert.equal(r.json.error, 'not_recognized');
    assert.equal(await count('SELECT count(*) n FROM attendance_events'), before);
    const rep = await kiosk.post('/api/kiosk/unknown-face', { action: 'check_in', best_score: 0.12 });
    assert.equal(rep.status, 200);
    assert.equal(await count(`SELECT count(*) n FROM attendance_exceptions WHERE kind = 'unknown_face' AND restaurant_id = $1`, [o.restaurantId]), 1);
    // Second report within the same 10-minute bucket is deduplicated.
    await kiosk.post('/api/kiosk/unknown-face', { action: 'check_in', best_score: 0.1 });
    assert.equal(await count(`SELECT count(*) n FROM attendance_exceptions WHERE kind = 'unknown_face' AND restaurant_id = $1`, [o.restaurantId]), 1);
    assert.equal(await count(`SELECT count(*) n FROM notification_outbox WHERE kind = 'unknown_face' AND restaurant_id = $1`, [o.restaurantId]), 1);
  });

  test('kiosk claiming a different employee than the server match is refused and flagged', async () => {
    const other = await createEmployee(o.web, { full_name: 'Other Person', staff_id: 'S101' });
    const r = await kiosk.post('/api/kiosk/attendance', faceAttempt(face, 'check_in', { employee_id: other.id }));
    assert.equal(r.status, 422);
    assert.equal(r.json.error, 'identity_mismatch');
    assert.equal(await count(`SELECT count(*) n FROM attendance_exceptions WHERE kind = 'identity_mismatch' AND restaurant_id = $1`, [o.restaurantId]), 1);
  });

  test('liveness is required when configured', async () => {
    const r = await kiosk.post('/api/kiosk/attendance', faceAttempt(face, 'check_in', { employee_id: sarah.id, liveness_passed: false }));
    assert.equal(r.status, 422);
    assert.equal(r.json.error, 'liveness_required');
  });

  test('concurrent CHECK IN from two kiosks records exactly one event', async () => {
    const [a, b] = await Promise.all([
      kiosk.post('/api/kiosk/attendance', faceAttempt(face, 'check_in', { employee_id: sarah.id })),
      kiosk2.post('/api/kiosk/attendance', faceAttempt(face, 'check_in', { employee_id: sarah.id })),
    ]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [200, 409]);
    assert.equal(await count(`SELECT count(*) n FROM attendance_sessions WHERE employee_id = $1 AND status = 'open'`, [sarah.id]), 1);
  });

  test('concurrent submissions of the same event id record it once', async () => {
    await h.owner.query(`UPDATE attendance_sessions SET check_in_at = now() - interval '2 hours' WHERE employee_id = $1 AND status = 'open'`, [sarah.id]);
    const body = faceAttempt(face, 'check_out', { employee_id: sarah.id });
    const results = await Promise.all([1, 2, 3, 4].map(() => kiosk.post('/api/kiosk/attendance', body)));
    assert.ok(results.every((r) => r.status === 200), JSON.stringify(results.map((r) => r.json)));
    assert.equal(results.filter((r) => r.json.result === 'recorded').length, 1);
    assert.equal(await count('SELECT count(*) n FROM attendance_events WHERE id = $1', [body.event_id]), 1);
  });

  test('PIN fallback works; wrong PINs lock after 5 attempts', async () => {
    assert.equal((await o.web.post(`/api/employees/${sarah.id}/pin`, { pin: '4321' })).status, 200);
    const pinIn = await kiosk.post('/api/kiosk/attendance', { event_id: randomUUID(), action: 'check_in', method: 'pin', staff_id: 's100', pin: '4321', offline: false });
    assert.equal(pinIn.status, 200, JSON.stringify(pinIn.json));
    assert.ok(pinIn.json.event.exception_flags.includes('pin_fallback'));
    for (let i = 0; i < 5; i++) {
      const bad = await kiosk.post('/api/kiosk/attendance', { event_id: randomUUID(), action: 'check_out', method: 'pin', staff_id: 'S100', pin: '0000', offline: false });
      assert.equal(bad.status, 401);
    }
    const locked = await kiosk.post('/api/kiosk/attendance', { event_id: randomUUID(), action: 'check_out', method: 'pin', staff_id: 'S100', pin: '4321', offline: false });
    assert.equal(locked.status, 423);
    await h.owner.query('UPDATE employees SET pin_locked_until = NULL, pin_failed = 0 WHERE id = $1', [sarah.id]);
  });

  test('append-only: attendance events cannot be edited or deleted, audit log cannot be altered', async () => {
    const app = new pg.Client({ connectionString: (h.built.ctx.cfg.DATABASE_URL) });
    await app.connect();
    await app.query('BEGIN');
    await app.query(`SELECT set_config('app.restaurant_id', $1, true)`, [o.restaurantId]);
    await assert.rejects(app.query(`UPDATE attendance_events SET event_time = now() WHERE employee_id = $1`, [sarah.id]), /immutable/);
    await app.query('ROLLBACK');
    await app.query('BEGIN');
    await app.query(`SELECT set_config('app.restaurant_id', $1, true)`, [o.restaurantId]);
    await assert.rejects(app.query(`DELETE FROM attendance_events WHERE employee_id = $1`, [sarah.id]), /permission denied|cannot be deleted/);
    await app.query('ROLLBACK');
    await assert.rejects(app.query(`UPDATE audit_logs SET action = 'x'`), /permission denied|append-only/);
    await app.end();
  });

  test('manual owner-assisted attendance and review workflow', async () => {
    const emp = await createEmployee(o.web, { full_name: 'Manual Person', staff_id: 'M1' });
    const noNote = await o.web.post('/api/attendance/manual', { employee_id: emp.id, action: 'check_in' });
    assert.equal(noNote.status, 400);
    const m = await o.web.post('/api/attendance/manual', { employee_id: emp.id, action: 'check_in', time: new Date(Date.now() - 3600_000).toISOString(), note: 'Kiosk tablet charging' });
    assert.equal(m.status, 201, JSON.stringify(m.json));
    const ev = (await h.owner.query('SELECT source, created_by_user_id, exception_flags FROM attendance_events WHERE id = $1', [m.json.event.id])).rows[0];
    assert.equal(ev.source, 'manual');
    assert.ok(ev.created_by_user_id);
    assert.ok(ev.exception_flags.includes('manual_entry'));
  });
});

describe('offline synchronisation', () => {
  test('offline events keep device time, sync idempotently, and conflicts go to review', async () => {
    const o = await signupOwner(h, 'off');
    const { kiosk } = await pairKiosk(h, o.web, 'Offline kiosk');
    const { kiosk: kioskB } = await pairKiosk(h, o.web, 'Online kiosk');
    await managerLogin(kiosk, o.email, o.password);
    const emp = await createEmployee(o.web, { full_name: 'Offline Olivia', staff_id: 'O1' });
    const face = randomIdentity();
    await enroll(kiosk, emp.id, face);

    const devIn = new Date(Date.now() - 5 * 3600_000);
    const offIn = faceAttempt(face, 'check_in', { employee_id: emp.id, offline: true, device_timestamp: devIn.toISOString() });
    const r1 = await kiosk.post('/api/kiosk/attendance', offIn);
    assert.equal(r1.status, 200, JSON.stringify(r1.json));
    assert.equal(r1.json.event.recorded_offline, true);
    assert.equal(r1.json.event.event_time, devIn.toISOString(), 'device timestamp preserved');
    assert.equal(r1.json.event.verification_status, 'verified');
    const row = (await h.owner.query('SELECT device_timestamp, server_received_at FROM attendance_events WHERE id = $1', [offIn.event_id])).rows[0];
    assert.ok(row.server_received_at.getTime() - row.device_timestamp.getTime() > 4 * 3600_000, 'sync time recorded separately');
    // Re-upload after a flaky connection: no duplicate.
    assert.equal((await kiosk.post('/api/kiosk/attendance', offIn)).json.result, 'duplicate');

    // Conflict: another kiosk (online) closed the session; then an offline check-out arrives.
    const online = await kioskB.post('/api/kiosk/attendance', faceAttempt(face, 'check_out', { employee_id: emp.id }));
    assert.equal(online.status, 200);
    const late = await kiosk.post('/api/kiosk/attendance', faceAttempt(face, 'check_out', { employee_id: emp.id, offline: true, device_timestamp: new Date(Date.now() - 60_000).toISOString() }));
    assert.equal(late.status, 200);
    assert.equal(late.json.result, 'pending_review');
    assert.equal(late.json.event.verification_status, 'pending_review');
    assert.ok(late.json.event.exception_flags.includes('offline_conflict'));
    assert.equal(await count(`SELECT count(*) n FROM attendance_exceptions WHERE kind = 'offline_conflict' AND restaurant_id = $1`, [o.restaurantId]), 1);

    // Owner approves after reviewing.
    const rev = await o.web.post(`/api/events/${late.json.event.id}/review`, { decision: 'approve', note: 'Confirmed with staff' });
    assert.equal(rev.status, 200);
    assert.equal(await count(`SELECT count(*) n FROM attendance_exceptions WHERE kind = 'offline_conflict' AND status = 'open' AND restaurant_id = $1`, [o.restaurantId]), 0);

    // Future device clock → flagged for review, time clamped to server time.
    const fut = await kiosk.post('/api/kiosk/attendance', faceAttempt(face, 'check_in', { employee_id: emp.id, offline: true, device_timestamp: new Date(Date.now() + 3 * 3600_000).toISOString() }));
    assert.equal(fut.json.result, 'pending_review');
    assert.ok(fut.json.event.exception_flags.includes('clock_skew'));
    assert.ok(Date.parse(fut.json.event.event_time) <= Date.now() + 1000);
  });

  test('offline event the server cannot accept raises a sync-failure alert instead of vanishing', async () => {
    const o = await signupOwner(h, 'offfail');
    const { kiosk } = await pairKiosk(h, o.web);
    const r = await kiosk.post('/api/kiosk/attendance', faceAttempt(null, 'check_in', { offline: true, device_timestamp: new Date(Date.now() - 60_000).toISOString() }));
    assert.equal(r.status, 422);
    assert.equal(await count(`SELECT count(*) n FROM attendance_exceptions WHERE kind = 'sync_failure' AND restaurant_id = $1`, [o.restaurantId]), 1);
    assert.equal(await count(`SELECT count(*) n FROM notification_outbox WHERE kind = 'sync_failure' AND restaurant_id = $1`, [o.restaurantId]), 1);
  });
});

describe('employee lifecycle & biometrics', () => {
  test('deactivation deletes biometrics, blocks attendance, keeps attendance history', async () => {
    const o = await signupOwner(h, 'life');
    const { kiosk } = await pairKiosk(h, o.web);
    await managerLogin(kiosk, o.email, o.password);
    const emp = await createEmployee(o.web, { full_name: 'Leaving Lee', staff_id: 'L1' });
    const face = randomIdentity();
    await enroll(kiosk, emp.id, face);
    assert.equal((await kiosk.post('/api/kiosk/attendance', faceAttempt(face, 'check_in', { employee_id: emp.id }))).status, 200);

    // Suspension blocks attendance but keeps templates.
    await o.web.post(`/api/employees/${emp.id}/status`, { status: 'suspended' });
    const susp = await kiosk.post('/api/kiosk/attendance', { event_id: randomUUID(), action: 'check_out', method: 'pin', staff_id: 'L1', pin: '1234', offline: false });
    assert.ok([401, 403].includes(susp.status));
    assert.ok((await count('SELECT count(*) n FROM face_templates WHERE employee_id = $1', [emp.id])) > 0);

    await o.web.post(`/api/employees/${emp.id}/status`, { status: 'deactivated' });
    assert.equal(await count('SELECT count(*) n FROM face_templates WHERE employee_id = $1', [emp.id]), 0);
    assert.equal(await count(`SELECT count(*) n FROM face_enrollments WHERE employee_id = $1 AND status = 'deleted'`, [emp.id]), 1);
    assert.equal(await count('SELECT count(*) n FROM attendance_events WHERE employee_id = $1', [emp.id]), 1, 'attendance retained');
    const tpl = await kiosk.get('/api/kiosk/templates');
    assert.equal(tpl.json.employees.length, 0);
  });

  test('explicit biometric deletion and PDPA data export (no templates in export)', async () => {
    const o = await signupOwner(h, 'pdpa');
    const { kiosk } = await pairKiosk(h, o.web);
    await managerLogin(kiosk, o.email, o.password);
    const emp = await createEmployee(o.web, { full_name: 'Data Subject', staff_id: 'D1' });
    await enroll(kiosk, emp.id, randomIdentity());
    const exp = await o.web.get(`/api/employees/${emp.id}/export`);
    assert.equal(exp.status, 200);
    assert.equal(exp.json.face_enrollments.length, 1);
    assert.ok(!JSON.stringify(exp.json).includes('ciphertext'));
    assert.equal((await o.web.del(`/api/employees/${emp.id}/biometrics`)).status, 200);
    assert.equal(await count('SELECT count(*) n FROM face_templates WHERE employee_id = $1', [emp.id]), 0);
    assert.equal(await count(`SELECT count(*) n FROM audit_logs WHERE action = 'biometrics.deleted' AND entity_id = $1`, [emp.id]), 1);
  });
});

describe('tenant isolation', () => {
  test('restaurant B cannot see or touch restaurant A data via API, kiosk, or direct SQL (RLS)', async () => {
    const A = await signupOwner(h, 'tenantA');
    const B = await signupOwner(h, 'tenantB');
    const { kiosk: kA } = await pairKiosk(h, A.web);
    await managerLogin(kA, A.email, A.password);
    const { kiosk: kB } = await pairKiosk(h, B.web);
    const empA = await createEmployee(A.web, { full_name: 'Alice of A', staff_id: 'A1' });
    const faceA = randomIdentity();
    await enroll(kA, empA.id, faceA);

    assert.equal((await B.web.get(`/api/employees/${empA.id}`)).status, 404);
    assert.equal((await B.web.patch(`/api/employees/${empA.id}`, { full_name: 'Hacked' })).status, 404);
    assert.equal((await B.web.del(`/api/employees/${empA.id}/biometrics`)).status, 404);
    assert.equal((await B.web.get(`/api/employees/${empA.id}/photo`)).status, 404);
    assert.ok(!(await B.web.get('/api/employees')).json.employees.some((e: any) => e.id === empA.id));
    // B's kiosk cannot recognise or record A's employee.
    const cross = await kB.post('/api/kiosk/attendance', faceAttempt(faceA, 'check_in', { employee_id: empA.id }));
    assert.equal(cross.status, 422);
    assert.equal((await kB.get('/api/kiosk/templates')).json.employees.length, 0);
    // B's manager cannot log in to A's kiosk manager mode.
    const mgr = await kA.post('/api/kiosk/manager/login', { email: B.email, password: B.password });
    assert.equal(mgr.status, 403);

    // Direct SQL as the runtime role: RLS hides other tenants even without a WHERE clause.
    const app = new pg.Client({ connectionString: h.built.ctx.cfg.DATABASE_URL });
    await app.connect();
    const noCtx = await app.query('SELECT count(*)::int n FROM employees');
    assert.equal(noCtx.rows[0].n, 0, 'no tenant context → no rows');
    await app.query('BEGIN');
    await app.query(`SELECT set_config('app.restaurant_id', $1, true)`, [B.restaurantId]);
    assert.equal((await app.query('SELECT count(*)::int n FROM employees WHERE id = $1', [empA.id])).rows[0].n, 0);
    assert.equal((await app.query('SELECT count(*)::int n FROM face_templates')).rows[0].n, 0);
    await assert.rejects(app.query(`INSERT INTO employees (restaurant_id, staff_id, full_name) VALUES ($1, 'X', 'X')`, [A.restaurantId]), /row-level security/);
    await app.query('ROLLBACK');
    await app.end();
  });
});

describe('corrections & audit trail', () => {
  test('approved time adjustment layers corrected values; originals and audit retained', async () => {
    const o = await signupOwner(h, 'corr');
    const emp = await createEmployee(o.web, { full_name: 'Corrected Chris', staff_id: 'C1' });
    const inAt = new Date(Date.now() - 8 * 3600_000).toISOString();
    const m = await o.web.post('/api/attendance/manual', { employee_id: emp.id, action: 'check_in', time: inAt, note: 'Forgot to check in' });
    const sid = m.json.session.id;
    // Request as attendance admin would; owner approves.
    const req1 = await o.web.post('/api/corrections', { kind: 'adjust_times', session_id: sid, check_out_at: new Date(Date.now() - 3600_000).toISOString(), reason: 'Forgot to check out' });
    assert.equal(req1.status, 201);
    assert.equal(req1.json.status, 'requested');
    assert.equal((await o.web.post(`/api/corrections/${req1.json.id}/approve`, { note: 'ok' })).status, 200);
    const s = (await h.owner.query('SELECT status, check_in_at, check_out_at, corrected_check_out_at, is_corrected, worked_minutes FROM attendance_sessions WHERE id = $1', [sid])).rows[0];
    assert.equal(s.status, 'closed');
    assert.equal(s.check_out_at, null, 'original (missing) checkout untouched');
    assert.ok(s.corrected_check_out_at);
    assert.equal(s.is_corrected, true);
    assert.ok(s.worked_minutes >= 419 && s.worked_minutes <= 421);
    assert.equal(await count(`SELECT count(*) n FROM audit_logs WHERE action IN ('correction.requested','correction.approved') AND restaurant_id = $1`, [o.restaurantId]), 2);
    assert.equal((await o.web.post(`/api/corrections/${req1.json.id}/approve`)).status, 409, 'cannot decide twice');

    const add = await o.web.post('/api/corrections', { kind: 'add_session', employee_id: emp.id, check_in_at: new Date(Date.now() - 50 * 3600_000).toISOString(), check_out_at: new Date(Date.now() - 42 * 3600_000).toISOString(), reason: 'Paper timesheet', apply_now: true });
    assert.equal(add.json.status, 'approved');
    assert.equal(await count(`SELECT count(*) n FROM attendance_events WHERE employee_id = $1 AND source = 'manual' AND 'correction' = ANY(exception_flags)`, [emp.id]), 2);
  });
});

describe('notifications & email delivery', () => {
  test('emails delivered over real SMTP, retried on failure, never duplicated', async () => {
    const { SMTPServer } = await import('smtp-server');
    const received: { to: string[]; raw: string }[] = [];
    const server = new SMTPServer({
      authOptional: true,
      disabledCommands: ['STARTTLS'],
      onData(stream, session, cb) {
        let raw = '';
        stream.on('data', (c) => (raw += c.toString()));
        stream.on('end', () => {
          received.push({ to: session.envelope.rcptTo.map((r) => r.address), raw });
          cb();
        });
      },
    });
    await new Promise<void>((res) => server.listen(2526, '127.0.0.1', () => res()));
    try {
      const o = await signupOwner(h, 'mail');
      const { kiosk } = await pairKiosk(h, o.web);
      await managerLogin(kiosk, o.email, o.password);
      const emp = await createEmployee(o.web, { full_name: 'Email Emma', staff_id: 'E1' });
      const face = randomIdentity();
      await enroll(kiosk, emp.id, face);
      const ev = await kiosk.post('/api/kiosk/attendance', faceAttempt(face, 'check_in', { employee_id: emp.id }));
      assert.equal(ev.status, 200);
      assert.equal(await count(`SELECT count(*) n FROM notification_outbox WHERE restaurant_id = $1 AND kind = 'check_in'`, [o.restaurantId]), 1);

      const { Worker } = await import('../src/worker.js');
      const { createMailer } = await import('../src/mailer.js');
      const { loadConfig } = await import('../src/config.js');
      const base = { ...process.env, NODE_ENV: 'test', DATABASE_URL: h.built.ctx.cfg.DATABASE_URL, TEMPLATE_KEYS: h.built.ctx.cfg.TEMPLATE_KEYS };

      // 1) SMTP server unreachable → stays queued with error + backoff (attendance unaffected).
      const badCfg = loadConfig({ ...base, EMAIL_TRANSPORT: 'smtp', SMTP_HOST: '127.0.0.1', SMTP_PORT: '2599', SMTP_IGNORE_TLS: 'true' });
      await new Worker(h.built.ctx.db, badCfg, createMailer(badCfg)).deliverOutbox();
      const failed = (await h.owner.query(`SELECT status, attempts, last_error, next_attempt_at FROM notification_outbox WHERE restaurant_id = $1 AND kind = 'check_in'`, [o.restaurantId])).rows[0];
      assert.equal(failed.status, 'queued');
      assert.equal(failed.attempts, 1);
      assert.match(failed.last_error, /ECONNREFUSED|connect/i);
      assert.ok(failed.next_attempt_at > new Date());

      // 2) Retry succeeds against the real SMTP server.
      await h.owner.query(`UPDATE notification_outbox SET next_attempt_at = now() WHERE restaurant_id = $1`, [o.restaurantId]);
      const goodCfg = loadConfig({ ...base, EMAIL_TRANSPORT: 'smtp', SMTP_HOST: '127.0.0.1', SMTP_PORT: '2526', SMTP_IGNORE_TLS: 'true', EMAIL_FROM: 'Attendance <att@test.invalid>' });
      const good = new Worker(h.built.ctx.db, goodCfg, createMailer(goodCfg));
      await good.deliverOutbox();
      const sent = (await h.owner.query(`SELECT status, attempts, provider_message_id FROM notification_outbox WHERE restaurant_id = $1 AND kind = 'check_in'`, [o.restaurantId])).rows[0];
      assert.equal(sent.status, 'sent');
      assert.equal(sent.attempts, 2);
      const msg = received.find((m) => m.raw.includes('Email Emma'));
      assert.ok(msg, 'email with employee name received');
      assert.deepEqual(msg!.to, [o.email]);
      assert.match(msg!.raw, /Check-in/);
      assert.match(msg!.raw, /E1/);
      assert.ok(!/Content-Type: image\//i.test(msg!.raw), 'no images attached');

      // 3) Running the worker again does not resend.
      const n = received.length;
      await good.deliverOutbox();
      assert.equal(received.length, n);

      // 4) Test email endpoint reports real delivery status.
      const t = await o.web.post('/api/notifications/test');
      assert.equal(t.status, 200);
      await good.deliverOutbox();
      const d = await o.web.get(`/api/notifications/deliveries?id=${t.json.id}`);
      assert.equal(d.json.deliveries[0].status, 'sent');
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });

  test('worker flags missing checkouts and offline kiosks once; daily summary queued once', async () => {
    const o = await signupOwner(h, 'worker');
    const { kiosk, deviceId } = await pairKiosk(h, o.web);
    const sh = await o.web.post('/api/shifts', { name: 'Ended shift', ...shiftAround(-300, 120), grace_minutes: 5 });
    const emp = await createEmployee(o.web, { full_name: 'Forgetful Fiona', staff_id: 'F1', shift_ids: [sh.json.shift.id] });
    await o.web.post('/api/attendance/manual', { employee_id: emp.id, action: 'check_in', time: new Date(Date.now() - 290 * 60_000).toISOString(), note: 'Fixture' });
    await h.owner.query(`UPDATE devices SET last_seen_at = now() - interval '2 hours' WHERE id = $1`, [deviceId]);
    await o.web.put('/api/notifications/settings', {
      emails: [o.email], on_check_in: false, on_check_out: false, important_only: false, late_arrival: true, missing_checkout: true, unknown_face: true,
      suspicious_events: true, device_offline: true, sync_failure: true, daily_summary: true, daily_summary_time: '00:00', quiet_hours_start: null, quiet_hours_end: null, include_staff_id: true,
    });
    const { Worker } = await import('../src/worker.js');
    const w = new Worker(h.built.ctx.db, h.built.ctx.cfg, null);
    await w.scanRestaurant(o.restaurantId);
    await w.scanRestaurant(o.restaurantId);
    assert.equal(await count(`SELECT count(*) n FROM attendance_exceptions WHERE kind = 'missing_checkout' AND restaurant_id = $1`, [o.restaurantId]), 1);
    assert.equal(await count(`SELECT count(*) n FROM notification_outbox WHERE kind = 'missing_checkout' AND restaurant_id = $1`, [o.restaurantId]), 1);
    assert.equal(await count(`SELECT count(*) n FROM attendance_sessions WHERE employee_id = $1 AND status = 'open'`, [emp.id]), 1, 'kept open for a late checkout');
    assert.equal(await count(`SELECT count(*) n FROM attendance_exceptions WHERE kind = 'device_offline' AND restaurant_id = $1`, [o.restaurantId]), 1);
    assert.equal(await count(`SELECT count(*) n FROM notification_outbox WHERE kind = 'device_offline' AND restaurant_id = $1`, [o.restaurantId]), 1);
    assert.equal(await count(`SELECT count(*) n FROM notification_outbox WHERE kind = 'daily_summary' AND restaurant_id = $1`, [o.restaurantId]), 1);
    // Heartbeat resolves the offline alert.
    await kiosk.post('/api/kiosk/heartbeat', { pending_queue_count: 0, synced: true });
    assert.equal(await count(`SELECT count(*) n FROM attendance_exceptions WHERE kind = 'device_offline' AND status = 'open' AND restaurant_id = $1`, [o.restaurantId]), 0);
    // Disabled transport marks deliveries as suppressed (honest status), not "sent".
    await w.deliverOutbox();
    assert.equal(await count(`SELECT count(*) n FROM notification_outbox WHERE status = 'sent' AND restaurant_id = $1`, [o.restaurantId]), 0);
    assert.ok((await count(`SELECT count(*) n FROM notification_outbox WHERE status = 'suppressed' AND restaurant_id = $1`, [o.restaurantId])) >= 3);
  });
});

describe('dashboard data, analytics, reports, realtime', () => {
  test('overview, analytics and CSV reports reflect real records', async () => {
    const o = await signupOwner(h, 'dash');
    const { kiosk } = await pairKiosk(h, o.web);
    await managerLogin(kiosk, o.email, o.password);
    const sh = await o.web.post('/api/shifts', { name: 'Now shift', ...shiftAround(-20), grace_minutes: 5 });
    const a = await createEmployee(o.web, { full_name: '=Formula Fred', staff_id: 'R1', shift_ids: [sh.json.shift.id] });
    await createEmployee(o.web, { full_name: 'Not Arrived Nina', staff_id: 'R2', shift_ids: [sh.json.shift.id] });
    const face = randomIdentity();
    await enroll(kiosk, a.id, face);
    await kiosk.post('/api/kiosk/attendance', faceAttempt(face, 'check_in', { employee_id: a.id }));

    const ov = await o.web.get('/api/overview');
    assert.equal(ov.status, 200);
    assert.equal(ov.json.metrics.expected_today, 2);
    assert.equal(ov.json.metrics.currently_working, 1);
    assert.equal(ov.json.metrics.late_arrivals, 1);
    assert.equal(ov.json.metrics.late_not_arrived, 1);
    assert.equal(ov.json.roster.length, 2);

    const today = localDate(new Date(), KL);
    const an = await o.web.get(`/api/analytics?from=${today}&to=${today}`);
    assert.equal(an.status, 200);
    assert.equal(an.json.summary.attended_scheduled_shifts, 1);
    assert.equal(an.json.summary.punctuality_rate, 0);
    assert.equal(an.json.summary.late_arrivals, 1);

    const csv = await o.web.get(`/api/reports/timesheet.csv?from=${today}&to=${today}`);
    assert.equal(csv.status, 200);
    assert.match(csv.body, /^# PROVISIONAL/);
    assert.match(csv.body, /'=Formula Fred/, 'formula injection neutralised');
    const evcsv = await o.web.get(`/api/reports/events.csv?from=${today}&to=${today}`);
    assert.match(evcsv.body, /check_in/);
    const feed = await o.web.get('/api/events?limit=10');
    assert.equal(feed.json.events.length, 1);
    assert.equal(feed.json.events[0].device_name, 'Front door kiosk');
  });

  test('SSE stream pushes committed attendance changes to the dashboard', async () => {
    const o = await signupOwner(h, 'sse');
    const { kiosk } = await pairKiosk(h, o.web);
    await managerLogin(kiosk, o.email, o.password);
    const emp = await createEmployee(o.web, { full_name: 'Realtime Rita', staff_id: 'RT1' });
    const face = randomIdentity();
    await enroll(kiosk, emp.id, face);

    const address = await h.built.app.listen({ port: 0, host: '127.0.0.1' });
    const ctrl = new AbortController();
    const res = await fetch(`${address}/api/stream`, { headers: { cookie: o.web.cookie }, signal: ctrl.signal });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type')!, /text\/event-stream/);
    const reader = res.body!.getReader();
    let buf = '';
    const waitFor = async (re: RegExp, ms = 5000) => {
      const deadline = Date.now() + ms;
      while (!re.test(buf)) {
        if (Date.now() > deadline) throw new Error(`timeout waiting for ${re}; got ${buf}`);
        const { value } = await Promise.race([reader.read(), new Promise<any>((r) => setTimeout(() => r({ value: undefined }), 200))]);
        if (value) buf += new TextDecoder().decode(value);
      }
    };
    await waitFor(/event: ready/);
    const ev = await kiosk.post('/api/kiosk/attendance', faceAttempt(face, 'check_in', { employee_id: emp.id }));
    await waitFor(new RegExp(`"table":"attendance_events","op":"INSERT","id":"${ev.json.event.id}"`));
    ctrl.abort();
  });

  test('app update endpoint reports newer signed releases', async () => {
    await h.owner.query(
      `INSERT INTO app_releases (platform, version_code, version_name, apk_url, apk_sha256, signing_cert_sha256, min_supported_version_code, release_notes)
       VALUES ('android', 5, '1.4.0', 'https://downloads.test.invalid/kiosk-1.4.0.apk', $1, $2, 3, 'TEST FIXTURE release')`,
      ['a'.repeat(64), 'b'.repeat(64)],
    );
    const r = await h.built.app.inject({ method: 'GET', url: '/api/app/android/latest?current=2' });
    assert.equal(r.json().update_available, true);
    assert.equal(r.json().mandatory, true);
    const r2 = await h.built.app.inject({ method: 'GET', url: '/api/app/android/latest?current=5' });
    assert.equal(r2.json().update_available, false);
    await assert.rejects(h.owner.query(`INSERT INTO app_releases (platform, version_code, version_name, apk_url, apk_sha256, signing_cert_sha256) VALUES ('android', 6, 'x', 'http://insecure', $1, $1)`, ['a'.repeat(64)]));
  });
});
