import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { computePay, toCents } from '../src/payroll.js';
import { scoreSessions, rankRows } from '../src/leaderboard.js';
import { resolveSettings } from '../src/settings.js';
import { startHarness, signupOwner, pairKiosk, managerLogin, createEmployee, enroll, faceAttempt, randomIdentity, WebClient, type Harness } from './helpers.js';

const S = resolveSettings({});
// Smallest byte sequence our server accepts as a JPEG (magic bytes + padding). TEST FIXTURE.
const FAKE_JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]).toString('base64');

describe('pay calculation (unit)', () => {
  test('12-hour day earns exactly the day salary; OT per hour = salary ÷ 12', () => {
    const p = computePay({ workedMinutes: 720, dailyRateCents: 15000, settings: S });
    assert.deepEqual([p.baseCents, p.otCents, p.otMinutes, p.standardMinutes], [15000, 0, 0, 720]);
    assert.equal(p.hourlyCents, 1250);
    const ot = computePay({ workedMinutes: 720 + 90, dailyRateCents: 15000, settings: S });
    assert.equal(ot.otMinutes, 90);
    assert.equal(ot.otCents, 1875); // 1.5 h × RM12.50
  });

  test('short day: full salary by default, prorated when configured', () => {
    assert.equal(computePay({ workedMinutes: 360, dailyRateCents: 12000, settings: S }).baseCents, 12000);
    const pro = resolveSettings({ payroll_short_day_policy: 'prorate' });
    assert.equal(computePay({ workedMinutes: 360, dailyRateCents: 12000, settings: pro }).baseCents, 6000);
  });

  test('OT rounding follows the restaurant rounding setting; odd salaries round to the nearest sen', () => {
    const r15 = resolveSettings({ rounding_minutes: 15, rounding_mode: 'down' });
    assert.equal(computePay({ workedMinutes: 720 + 44, dailyRateCents: 15000, settings: r15 }).otMinutes, 30);
    assert.equal(computePay({ workedMinutes: 720 + 7, dailyRateCents: 10000, settings: S }).otCents, 97); // 7/720 × 100.00 = 0.9722
    const ten = resolveSettings({ payroll_standard_hours: 10 });
    assert.equal(computePay({ workedMinutes: 660, dailyRateCents: 10000, settings: ten }).otCents, 1000);
  });

  test('money parsing is exact to the sen', () => {
    assert.equal(toCents(150), 15000);
    assert.equal(toCents(149.99), 14999);
    assert.equal(toCents(0.1 + 0.2), 30);
    assert.throws(() => toCents(1.005));
  });

  test('leaderboard points, streak and tie ranking', () => {
    const at = (d: number, h = 9) => new Date(Date.UTC(2026, 9, d, h - 8));
    const base = { employee_id: 'e', scheduled_start: at(1), scheduled_end: at(1, 21), worked_minutes: 720 };
    const s = scoreSessions([
      { ...base, status: 'closed', eff_in: at(1), is_late: true },
      { ...base, status: 'closed', eff_in: at(2), is_late: false },
      { ...base, status: 'closed', eff_in: at(3), is_late: false },
      { ...base, status: 'missing_checkout', eff_in: at(4), is_late: false, worked_minutes: null },
      { ...base, status: 'closed', eff_in: at(5), is_late: false },
    ], 'Asia/Kuala_Lumpur', at(10));
    // on_time 4 ×10 + 5 days ×5 − 1 late ×5 − 1 missing ×10 = 50
    assert.deepEqual([s.points, s.on_time, s.late, s.missing_checkouts, s.days_worked, s.streak], [50, 4, 1, 1, 5, 1]);
    assert.equal(s.punctuality_rate, 80);
    const ranked = rankRows([
      { full_name: 'B', points: 50, worked_minutes: 100 },
      { full_name: 'A', points: 50, worked_minutes: 100 },
      { full_name: 'C', points: 70, worked_minutes: 10 },
      { full_name: 'D', points: 10, worked_minutes: 10 },
    ]);
    assert.deepEqual(ranked.map((r) => `${r.rank}${r.full_name}`), ['1C', '2A', '2B', '4D']);
  });
});

describe('payroll (integration, real PostgreSQL)', () => {
  let h: Harness;
  before(async () => {
    h = await startHarness('attendance_payroll');
  });
  after(async () => {
    await h?.close();
  });
  const n = async (sql: string, p: unknown[] = []) => Number((await h.owner.query(sql, p)).rows[0].n);

  async function setup(label: string) {
    const o = await signupOwner(h, label);
    const { kiosk } = await pairKiosk(h, o.web);
    await managerLogin(kiosk, o.email, o.password);
    const emp = await createEmployee(o.web, { full_name: 'Siti Aminah', preferred_name: 'Siti', staff_id: `P${label}` });
    const face = randomIdentity();
    assert.equal((await enroll(kiosk, emp.id, face)).status, 200);
    kiosk.managerToken = '';
    /** Check in, pretend the shift lasted `minutes`, then check out at the kiosk. */
    const work = async (minutes: number) => {
      assert.equal((await kiosk.post('/api/kiosk/attendance', faceAttempt(face, 'check_in', { employee_id: emp.id }))).status, 200);
      await h.owner.query(`UPDATE attendance_sessions SET check_in_at = now() - make_interval(mins => $2) WHERE employee_id = $1 AND status = 'open'`, [emp.id, minutes]);
      const out = await kiosk.post('/api/kiosk/attendance', faceAttempt(face, 'check_out', { employee_id: emp.id }));
      assert.equal(out.status, 200, JSON.stringify(out.json));
      return out.json;
    };
    return { o, kiosk, emp, face, work };
  }

  test('only the owner sets salaries; managers and admins cannot', async () => {
    const { o, emp } = await setup('rates');
    const add = await o.web.post('/api/team', { email: `mgr-${randomUUID().slice(0, 6)}@test.invalid`, full_name: 'Manager M', role: 'manager' });
    const team = await o.web.get('/api/team');
    const mgr = new WebClient(h);
    await mgr.post('/api/auth/login', { email: team.json.members.find((m: any) => m.role === 'manager').email, password: add.json.temporary_password });
    assert.equal((await mgr.put(`/api/employees/${emp.id}/rate`, { daily_rate: 999 })).status, 403);
    assert.equal((await mgr.get('/api/payroll/rates')).status, 200, 'managers can see rates to pay staff');
    const ok = await o.web.put(`/api/employees/${emp.id}/rate`, { daily_rate: 150 });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.daily_rate_cents, 15000);
    assert.equal(ok.json.hourly_ot_cents, 1250);
    assert.equal((await o.web.put(`/api/employees/${emp.id}/rate`, { daily_rate: 150.005 })).status, 400);
    const rates = await o.web.get('/api/payroll/rates');
    assert.equal(rates.json.employees.find((e: any) => e.employee_id === emp.id).daily_rate_cents, 15000);
    assert.equal(await n(`SELECT count(*) n FROM audit_logs WHERE action = 'payroll.rate_set'`), 1);
  });

  test('check-out creates a pending payout: 12 h salary + OT at salary ÷ 12 per hour', async () => {
    const { o, emp, work } = await setup('ot');
    await o.web.put(`/api/employees/${emp.id}/rate`, { daily_rate: 150 });
    await work(13 * 60); // 13 hours → 1 h OT
    const list = await o.web.get('/api/payouts?status=pending');
    assert.equal(list.status, 200);
    const p = list.json.payouts.find((x: any) => x.employee_id === emp.id);
    assert.ok(p, 'payout created at check-out');
    assert.equal(p.status, 'pending');
    assert.ok([60, 61].includes(p.ot_minutes), `ot ${p.ot_minutes}`);
    assert.equal(p.base_cents, 15000);
    assert.equal(p.ot_cents, Math.round((15000 * p.ot_minutes) / 720));
    assert.equal(p.total_cents, p.base_cents + p.ot_cents);
    assert.equal(list.json.summary.pending_count, 1);
    assert.equal(list.json.summary.pending_cents, p.total_cents);
    assert.equal(list.json.pending_by_employee[0].count, 1);
    // The check-out email tells the owner what is due.
    const mail = (await h.owner.query(`SELECT text_body FROM notification_outbox WHERE restaurant_id = $1 AND kind = 'check_out'`, [o.restaurantId])).rows[0];
    assert.match(mail.text_body, /Pay due: RM\s?16[23]\.\d\d \(incl\. 1h 0[01]m OT\)/);
  });

  test('missing salary is flagged, cannot be paid, and fills in once the boss sets it', async () => {
    const { o, emp, work } = await setup('missing');
    await work(12 * 60);
    let p = (await o.web.get('/api/payouts')).json.payouts[0];
    assert.equal(p.rate_missing, true);
    assert.equal(p.total_cents, 0);
    const pay = await o.web.post(`/api/payouts/${p.id}/pay`, { method: 'qr' });
    assert.equal(pay.status, 409);
    assert.equal(pay.json.error, 'rate_missing');
    const set = await o.web.put(`/api/employees/${emp.id}/rate`, { daily_rate: 120 });
    assert.equal(set.json.pending_payouts_refreshed, 1);
    p = (await o.web.get('/api/payouts')).json.payouts[0];
    assert.equal(p.rate_missing, false);
    assert.equal(p.base_cents, 12000);
  });

  test('cash requires a payslip photo; QR does not; paid payouts are frozen and cannot be paid twice', async () => {
    const { o, emp, work } = await setup('pay');
    await o.web.put(`/api/employees/${emp.id}/rate`, { daily_rate: 150 });
    await work(12 * 60);
    await work(12 * 60);
    const [p1, p2] = (await o.web.get('/api/payouts')).json.payouts;
    const noPhoto = await o.web.post(`/api/payouts/${p1.id}/pay`, { method: 'cash' });
    assert.equal(noPhoto.status, 400);
    assert.equal(noPhoto.json.error, 'photo_required');
    const bad = await o.web.post(`/api/payouts/${p1.id}/pay`, { method: 'cash', photo_base64: Buffer.from('not an image at all, just text that is long enough to pass the size floor of one hundred bytes.....').toString('base64') });
    assert.equal(bad.status, 400);
    const cash = await o.web.post(`/api/payouts/${p1.id}/pay`, { method: 'cash', photo_base64: FAKE_JPEG, note: 'Signed by staff' });
    assert.equal(cash.status, 200, JSON.stringify(cash.json));
    assert.equal(cash.json.status, 'paid');
    assert.equal(cash.json.method, 'cash');
    assert.equal(cash.json.has_proof, true);
    const proof = await h.built.app.inject({ method: 'GET', url: `/api/payouts/${p1.id}/proof`, headers: { cookie: o.web.cookie } });
    assert.equal(proof.statusCode, 200);
    assert.equal(proof.headers['content-type'], 'image/jpeg');
    assert.equal((await o.web.post(`/api/payouts/${p1.id}/pay`, { method: 'qr' })).status, 409, 'cannot pay twice');
    const qr = await o.web.post(`/api/payouts/${p2.id}/pay`, { method: 'qr' });
    assert.equal(qr.status, 200);
    assert.equal(qr.json.has_proof, false);
    // Database refuses to change money on a paid payout.
    const app = new pg.Client({ connectionString: h.built.ctx.cfg.DATABASE_URL });
    await app.connect();
    await app.query('BEGIN');
    await app.query(`SELECT set_config('app.restaurant_id', $1, true)`, [o.restaurantId]);
    await assert.rejects(app.query('UPDATE payouts SET total_cents = 1 WHERE id = $1', [p1.id]), /reopen/);
    await app.query('ROLLBACK');
    await app.end();
    const s = (await o.web.get('/api/payouts?status=all')).json.summary;
    assert.equal(s.pending_count, 0);
    assert.equal(s.paid_month_cash_cents, p1.total_cents);
    assert.equal(s.paid_month_qr_cents, p2.total_cents);
    assert.equal(await n(`SELECT count(*) n FROM audit_logs WHERE action = 'payroll.paid'`), 2);
  });

  test('keep pending with a note, adjust with a reason, owner-only reopen', async () => {
    const { o, emp, work } = await setup('adjust');
    await o.web.put(`/api/employees/${emp.id}/rate`, { daily_rate: 100 });
    await work(12 * 60);
    const p = (await o.web.get('/api/payouts')).json.payouts[0];
    const note = await o.web.post(`/api/payouts/${p.id}/note`, { note: 'Pay on Friday' });
    assert.equal(note.json.pay_note, 'Pay on Friday');
    assert.equal(note.json.status, 'pending');
    assert.equal((await o.web.post(`/api/payouts/${p.id}/adjust`, { adjustment: -20, reason: '' })).status, 400);
    assert.equal((await o.web.post(`/api/payouts/${p.id}/adjust`, { adjustment: -200, reason: 'Advance' })).status, 400, 'total cannot go negative');
    const adj = await o.web.post(`/api/payouts/${p.id}/adjust`, { adjustment: -20.5, reason: 'Salary advance taken Monday' });
    assert.equal(adj.json.total_cents, 10000 - 2050);
    await o.web.post(`/api/payouts/${p.id}/pay`, { method: 'qr' });
    const reopen = await o.web.post(`/api/payouts/${p.id}/reopen`, { reason: 'Paid the wrong person' });
    assert.equal(reopen.status, 200);
    assert.equal(reopen.json.status, 'pending');
    assert.equal(reopen.json.method, null);
    assert.equal(reopen.json.total_cents, 10000 - 2050, 'adjustment kept');
  });

  test('changing attendance after payment flags the payout instead of silently changing money', async () => {
    const { o, emp, work } = await setup('review');
    await o.web.put(`/api/employees/${emp.id}/rate`, { daily_rate: 150 });
    await work(12 * 60);
    const p = (await o.web.get('/api/payouts')).json.payouts[0];
    await o.web.post(`/api/payouts/${p.id}/pay`, { method: 'qr' });
    const corr = await o.web.post('/api/corrections', { kind: 'adjust_times', session_id: p.session_id, check_out_at: new Date(Date.now() + 0).toISOString(), check_in_at: new Date(Date.now() - 14 * 3600_000).toISOString(), reason: 'Forgot to clock earlier', apply_now: true });
    assert.equal(corr.status, 201, JSON.stringify(corr.json));
    const after1 = (await o.web.get(`/api/payouts?status=all&id=${p.id}`)).json.payouts[0];
    assert.equal(after1.total_cents, p.total_cents, 'paid amount untouched');
    assert.equal(after1.needs_review, true);
    assert.match(after1.review_reason, /changed after payment/);
    assert.equal((await o.web.post(`/api/payouts/${p.id}/resolve-review`)).status, 200);
  });

  test('pending payout follows corrections and is voided if the session is voided', async () => {
    const { o, emp, work } = await setup('void');
    await o.web.put(`/api/employees/${emp.id}/rate`, { daily_rate: 150 });
    await work(12 * 60);
    const p = (await o.web.get('/api/payouts')).json.payouts[0];
    await o.web.post('/api/corrections', { kind: 'adjust_times', session_id: p.session_id, check_in_at: new Date(Date.now() - 15 * 3600_000).toISOString(), reason: 'Arrived earlier', apply_now: true });
    const up = (await o.web.get(`/api/payouts?id=${p.id}`)).json.payouts[0];
    assert.ok(up.ot_minutes >= 179 && up.ot_minutes <= 181, `ot ${up.ot_minutes}`);
    await o.web.post('/api/corrections', { kind: 'void_session', session_id: p.session_id, reason: 'Test record', apply_now: true });
    const v = (await o.web.get(`/api/payouts?status=all&id=${p.id}`)).json.payouts[0];
    assert.equal(v.status, 'void');
    assert.equal((await o.web.get('/api/payouts')).json.summary.pending_count, 0);
  });

  test('payroll is invisible to attendance admins and to other restaurants', async () => {
    const A = await setup('isoA');
    await A.o.web.put(`/api/employees/${A.emp.id}/rate`, { daily_rate: 150 });
    await A.work(12 * 60);
    const pid = (await A.o.web.get('/api/payouts')).json.payouts[0].id;
    const B = await signupOwner(h, 'isoB');
    assert.equal((await B.web.get('/api/payouts')).json.payouts.length, 0);
    assert.equal((await B.web.post(`/api/payouts/${pid}/pay`, { method: 'qr' })).status, 404);
    assert.equal((await B.web.put(`/api/employees/${A.emp.id}/rate`, { daily_rate: 1 })).status, 404);
    const add = await A.o.web.post('/api/team', { email: `adm-${randomUUID().slice(0, 6)}@test.invalid`, full_name: 'Admin', role: 'attendance_admin' });
    const email = (await A.o.web.get('/api/team')).json.members.find((m: any) => m.role === 'attendance_admin').email;
    const adm = new WebClient(h);
    await adm.post('/api/auth/login', { email, password: add.json.temporary_password });
    assert.equal((await adm.get('/api/payouts')).status, 403);
    assert.equal((await adm.get(`/api/payouts/${pid}/proof`)).status, 403);
  });

  test('leaderboard ranks staff from real attendance and CSV export works', async () => {
    const { o, emp, work } = await setup('board');
    await o.web.put(`/api/employees/${emp.id}/rate`, { daily_rate: 150 });
    await work(12 * 60);
    const lb = await o.web.get('/api/leaderboard?period=week');
    assert.equal(lb.status, 200);
    assert.equal(lb.json.rows.length, 1);
    assert.equal(lb.json.rows[0].rank, 1);
    assert.equal(lb.json.rows[0].days_worked, 1);
    assert.equal(lb.json.rows[0].points, 5);
    assert.ok(lb.json.restaurant.includes('TEST FIXTURE'));
    const today = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 2 * 86400_000).toISOString().slice(0, 10);
    const csv = await o.web.get(`/api/reports/payouts.csv?from=${from}&to=${today}`);
    assert.equal(csv.status, 200);
    assert.match(csv.body, /Siti Aminah/);
    assert.match(csv.body, /150\.00/);
  });
});
