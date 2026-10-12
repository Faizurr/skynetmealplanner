#!/usr/bin/env node
/**
 * TEST FIXTURES ONLY. Seeds a demo restaurant ("Demo Bistro (test data)") through the real API
 * so the dashboard has realistic history to display during development and screenshots.
 *
 *   BASE_URL=http://localhost:8090 node scripts/seed.mjs
 *
 * Optional: SEED_DATABASE_URL=postgres://… backdates the demo shift assignments by 30 days with
 * psql (there is no API for that) so historical sessions link to shifts and analytics show
 * punctuality/absences. Only rows of the newly created demo restaurant are touched.
 */
import { execFileSync } from 'node:child_process';

const BASE = process.env.BASE_URL ?? 'http://localhost:8090';
const TZ_OFFSET_H = 8; // Asia/Kuala_Lumpur (no DST)
const stamp = Date.now().toString(36);
const EMAIL = process.env.SEED_EMAIL ?? `owner+${stamp}@demo-bistro.test`;
const PASSWORD = process.env.SEED_PASSWORD ?? 'demo-password-123';

let cookie = '';
async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-CSRF': '1', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
  return data;
}

// Seeded PRNG so runs are reproducible.
let seed = 42;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const between = (a, b) => Math.round(a + rnd() * (b - a));

const pad = (n) => String(n).padStart(2, '0');
function klNow() {
  const d = new Date(Date.now() + TZ_OFFSET_H * 3600_000);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes() };
}
/** ISO instant for a local KL wall-clock time on (today + dayOffset), plus extra minutes. */
function kl(dayOffset, hhmm, plusMin = 0) {
  const t = klNow();
  const [h, mi] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(t.y, t.m - 1, t.d + dayOffset, h - TZ_OFFSET_H, mi + plusMin)).toISOString();
}
function weekday(dayOffset) {
  const t = klNow();
  return ((new Date(Date.UTC(t.y, t.m - 1, t.d + dayOffset)).getUTCDay() + 6) % 7) + 1; // 1=Mon
}

async function main() {
  console.log(`Seeding TEST DATA at ${BASE}`);
  const su = await call('POST', '/api/auth/signup', {
    restaurant_name: 'Demo Bistro (test data)',
    branch_name: 'Bangsar (test data)',
    timezone: 'Asia/Kuala_Lumpur',
    full_name: 'Alex Demo-Owner',
    email: EMAIL,
    password: PASSWORD,
  });
  const restaurantId = su.restaurant_id;
  const { branches } = await call('GET', '/api/branches');
  const main = branches[0];
  const { branch: river } = await call('POST', '/api/branches', { name: 'Riverside (test data)', address: '12 Jalan Contoh (fictional)' });

  const mk = (b) => call('POST', '/api/shifts', b).then((r) => r.shift.id);
  const morning = await mk({ name: 'Morning', start_time: '08:00', end_time: '16:00', days_of_week: [1, 2, 3, 4, 5, 6], grace_minutes: 5, unpaid_break_minutes: 30, break_applies_after_minutes: 360, overtime_after_minutes: 480 });
  const dinner = await mk({ name: 'Dinner service', start_time: '16:00', end_time: '23:00', days_of_week: [1, 2, 3, 4, 5, 6, 7], grace_minutes: 5, unpaid_break_minutes: 0, break_applies_after_minutes: 360, overtime_after_minutes: 420 });
  const late = await mk({ name: 'Late close', start_time: '18:00', end_time: '02:00', days_of_week: [5, 6], grace_minutes: 10, unpaid_break_minutes: 30, break_applies_after_minutes: 360, overtime_after_minutes: 480 });
  const shiftDef = { [morning]: ['08:00', '16:00', [1, 2, 3, 4, 5, 6]], [dinner]: ['16:00', '23:00', [1, 2, 3, 4, 5, 6, 7]], [late]: ['18:00', '02:00', [5, 6]] };

  const people = [
    { full_name: 'Aisyah Rahman', staff_id: 'DB-001', job_title: 'Head Chef', department: 'Kitchen', shift_ids: [morning], pin: '4821', lateBias: 0 },
    { full_name: 'Daniel Tan', staff_id: 'DB-002', job_title: 'Sous Chef', department: 'Kitchen', shift_ids: [morning], lateBias: 2 },
    { full_name: 'Priya Nair', staff_id: 'DB-003', job_title: 'Server', department: 'Front of house', shift_ids: [dinner], pin: '1957', lateBias: 0 },
    { full_name: 'Ravi Kumar', staff_id: 'DB-004', job_title: 'Server', department: 'Front of house', shift_ids: [dinner], lateBias: 14 },
    { full_name: 'Mei Ling Wong', staff_id: 'DB-005', preferred_name: 'Mei', job_title: 'Cashier', department: 'Front of house', shift_ids: [morning], lateBias: 1 },
    { full_name: 'Hafiz Ismail', staff_id: 'DB-006', job_title: 'Kitchen Porter', department: 'Kitchen', shift_ids: [late], lateBias: 4 },
    { full_name: 'Sofia Lim', staff_id: 'DB-007', job_title: 'Bartender', department: 'Bar', shift_ids: [dinner], lateBias: 3 },
    { full_name: 'Arjun Menon', staff_id: 'DB-008', job_title: 'Line Cook', department: 'Kitchen', shift_ids: [dinner], lateBias: 6 },
    { full_name: 'Nurul Huda', staff_id: 'DB-009', job_title: 'Server', department: 'Front of house', shift_ids: [morning], branch: 'river', lateBias: 2 },
    { full_name: 'Kevin Ong', staff_id: 'DB-010', job_title: 'Floor Manager', department: 'Management', shift_ids: [], lateBias: 0 },
  ];
  const emps = [];
  for (const p of people) {
    const { lateBias, branch, ...body } = p;
    const r = await call('POST', '/api/employees', { ...body, branch_id: branch === 'river' ? river.id : main.id, email: `${p.staff_id.toLowerCase()}@demo-bistro.test` });
    emps.push({ ...r.employee, lateBias, shift_ids: p.shift_ids });
  }
  const suspended = await call('POST', '/api/employees', { full_name: 'Tom Example', staff_id: 'DB-011', job_title: 'Dishwasher', branch_id: main.id });
  await call('POST', `/api/employees/${suspended.employee.id}/status`, { status: 'suspended' });

  if (process.env.SEED_DATABASE_URL) {
    execFileSync('psql', [process.env.SEED_DATABASE_URL, '-v', 'ON_ERROR_STOP=1', '-c',
      `UPDATE shift_assignments SET effective_from = CURRENT_DATE - 21 WHERE restaurant_id = '${restaurantId}'`], { stdio: 'inherit' });
  } else {
    console.log('(SEED_DATABASE_URL not set: history will not be linked to shifts)');
  }

  // History: previous 21 days, created as applied "add_session" corrections (labelled in the UI).
  const now = Date.now();
  let sessions = 0;
  for (let day = -21; day <= -1; day++) {
    const wd = weekday(day);
    for (const e of emps) {
      const shiftId = e.shift_ids[0];
      if (!shiftId) {
        if (wd <= 5 && rnd() < 0.8) {
          const inAt = kl(day, '10:00', between(-20, 30));
          const outAt = kl(day, '18:30', between(-30, 45));
          await call('POST', '/api/corrections', { kind: 'add_session', employee_id: e.id, check_in_at: inAt, check_out_at: outAt, reason: 'Test data: historical session', apply_now: true });
          sessions++;
        }
        continue;
      }
      const [start, end, days] = shiftDef[shiftId];
      if (!days.includes(wd)) continue;
      if (rnd() < 0.07) continue; // absence
      const lateMin = rnd() < (e.lateBias > 10 ? 0.55 : 0.12) ? between(6, 6 + e.lateBias + 18) : between(-12, 4);
      const inAt = kl(day, start, lateMin);
      const overnight = end <= start;
      const outAt = kl(day + (overnight ? 1 : 0), end, between(-8, rnd() < 0.2 ? 75 : 20));
      if (Date.parse(outAt) > now - 60_000) continue;
      await call('POST', '/api/corrections', { kind: 'add_session', employee_id: e.id, check_in_at: inAt, check_out_at: outAt, reason: 'Test data: historical session', apply_now: true });
      sessions++;
    }
  }
  console.log(`created ${sessions} historical sessions`);

  // Today: manual events at realistic earlier times (only those already in the past).
  const t = klNow();
  const nowMin = t.h * 60 + t.mi;
  const at = (hhmm, plus) => {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m + plus <= nowMin - 2;
  };
  const byId = Object.fromEntries(emps.map((e) => [e.staff_id, e]));
  const todayEvents = [
    ['DB-001', 'check_in', '08:00', -6], ['DB-002', 'check_in', '08:00', 3], ['DB-005', 'check_in', '08:00', 17], ['DB-009', 'check_in', '08:00', -2],
    ['DB-010', 'check_in', '10:00', 4], ['DB-001', 'check_out', '16:00', 6], ['DB-009', 'check_out', '16:00', 1],
    ['DB-003', 'check_in', '16:00', -4], ['DB-004', 'check_in', '16:00', 23], ['DB-007', 'check_in', '16:00', 2],
  ];
  for (const [sid, action, base, plus] of todayEvents) {
    if (!at(base, plus)) continue;
    await call('POST', '/api/attendance/manual', { employee_id: byId[sid].id, action, time: kl(0, base, plus), note: 'Test data: kiosk not yet installed' });
  }
  // Yesterday's late-close shift with no check-out → becomes a missing check-out alert.
  {
    try {
      await call('POST', '/api/attendance/manual', { employee_id: byId['DB-006'].id, action: 'check_in', time: kl(-1, '18:00', 7), note: 'Test data: forgot to check out' });
    } catch (e) {
      console.log('skip open session:', e.message);
    }
  }
  // A pending correction request (not applied) for review.
  const { sessions: recent } = await call('GET', `/api/sessions?from=${kl(-3, '00:00').slice(0, 10)}&to=${kl(-1, '00:00').slice(0, 10)}&employee_id=${byId['DB-008'].id}`);
  if (recent[0]) {
    const s = recent[0];
    await call('POST', '/api/corrections', { kind: 'adjust_times', session_id: s.id, check_out_at: new Date(Date.parse(s.effective_check_out ?? s.effective_check_in) + 25 * 60_000).toISOString(), reason: 'Test data: stayed late to clean the grill', apply_now: false });
  }
  // A kiosk waiting to be paired.
  await call('POST', '/api/devices', { name: 'Front entrance (test)', branch_id: main.id });

  console.log('\nDone. Sign in with:');
  console.log(`  email:    ${EMAIL}`);
  console.log(`  password: ${PASSWORD}`);
  console.log(JSON.stringify({ email: EMAIL, password: PASSWORD, restaurant_id: restaurantId }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
