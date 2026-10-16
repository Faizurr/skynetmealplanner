import { test, expect, type APIRequestContext, type Page, type TestInfo } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import sharp from 'sharp';

/**
 * Payroll + leaderboard flow against the REAL backend (TEST FIXTURE data, labelled as such):
 * salaries → check-outs create payouts → pay in cash with a payslip photo / via QR / keep pending →
 * live "checked out, RM… due" alert → leaderboard + share image.
 * Optional PG_OWNER_URL backdates shift assignments so past days count as scheduled.
 */
const SHOTS = path.resolve(process.cwd(), '../docs/screenshots');
mkdirSync(SHOTS, { recursive: true });
const TZ = 'Asia/Kuala_Lumpur';

function variant(info: TestInfo) {
  const [size, scheme] = info.project.name.split('-');
  return { size, scheme, mobile: size === 'mobile' };
}
async function shot(page: Page, info: TestInfo, name: string, opts: { keepToasts?: boolean; fullPage?: boolean } = {}) {
  const { size, scheme } = variant(info);
  if (!opts.keepToasts) for (const b of await page.locator('.toast-close').all()) await b.click({ timeout: 1000 }).catch(() => {});
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(SHOTS, `pwa-${size}-${name}-${scheme}.png`), fullPage: opts.fullPage });
}
async function noOverflow(page: Page, where: string) {
  const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  expect(sw, `horizontal overflow on ${where}`).toBeLessThanOrEqual(cw);
}
function klDate(offsetDays: number): string {
  const d = new Date(Date.now() + offsetDays * 86400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
/** ISO instant for a KL wall-clock time on a given local date (KL is UTC+8, no DST). */
function kl(ymd: string, hhmm: string, plusMin = 0): string {
  const [h, m] = hhmm.split(':').map(Number);
  const t = Date.parse(`${ymd}T00:00:00+08:00`) + (h * 60 + m + plusMin) * 60_000;
  return new Date(t).toISOString();
}
async function call(req: APIRequestContext, method: 'GET' | 'POST' | 'PUT', url: string, data?: unknown) {
  const res = await req.fetch(url, { method, data, headers: { 'X-CSRF': '1' } });
  if (!res.ok()) throw new Error(`${method} ${url} → ${res.status()} ${await res.text()}`);
  return res.json();
}

async function payslipJpeg(): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1200">
    <rect width="100%" height="100%" fill="#fbfaf6"/>
    <text x="70" y="140" font-family="Helvetica" font-size="56" font-weight="700" fill="#222">PAYSLIP (TEST FIXTURE)</text>
    <text x="70" y="230" font-family="Helvetica" font-size="38" fill="#444">Siti Aminah · 12 h + OT</text>
    <line x1="70" y1="290" x2="830" y2="290" stroke="#bbb" stroke-width="3"/>
    <text x="70" y="380" font-family="Helvetica" font-size="44" fill="#222">Total paid: RM 168.75</text>
    <text x="70" y="1050" font-family="Helvetica" font-size="40" fill="#222">Signature: ____________</text>
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 85 }).toBuffer();
}

test('payroll: salaries → payouts at check-out → cash with photo / QR / pending → live alert → leaderboard share', async ({ page, browser }, info) => {
  const { mobile } = variant(info);
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const loc = m.location()?.url ?? '';
    if (/status of 401/.test(m.text()) && loc.endsWith('/api/auth/me')) return;
    errors.push(`${m.text()} @ ${loc}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

  // Sign up (UI) ------------------------------------------------------------------
  const email = `pay+${info.project.name}-${Date.now()}@demo-bistro.test`;
  await page.goto('/#/signup');
  await page.getByLabel('Restaurant name').fill('Nasi Kandar Corner (test data)');
  await page.getByLabel('Your name').fill('Boss Owner');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('e2e-password-123');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
  const req = page.request;
  const me = await call(req, 'GET', '/api/auth/me');

  // Fixtures via API: a 12-hour shift and four staff ------------------------------
  const shift = await call(req, 'POST', '/api/shifts', { name: 'Day (12 h)', start_time: '08:00', end_time: '20:00', days_of_week: [1, 2, 3, 4, 5, 6, 7], grace_minutes: 5 });
  const staff = [
    { full_name: 'Siti Aminah', preferred_name: 'Siti', staff_id: 'NK-01', job_title: 'Cashier', rate: 150 },
    { full_name: 'Ahmad Faizal', preferred_name: 'Faizal', staff_id: 'NK-02', job_title: 'Cook', rate: 180 },
    { full_name: 'Tan Mei Ling', preferred_name: 'Mei Ling', staff_id: 'NK-03', job_title: 'Server', rate: 120 },
    { full_name: 'Raj Kumar', preferred_name: 'Raj', staff_id: 'NK-04', job_title: 'Dishwasher', rate: 0 },
  ];
  const ids: Record<string, string> = {};
  for (const s of staff) {
    const r = await call(req, 'POST', '/api/employees', { full_name: s.full_name, preferred_name: s.preferred_name, staff_id: s.staff_id, job_title: s.job_title, shift_ids: [shift.shift.id] });
    ids[s.staff_id] = r.employee.id;
  }
  if (process.env.PG_OWNER_URL) {
    execFileSync('psql', [process.env.PG_OWNER_URL, '-v', 'ON_ERROR_STOP=1', '-qc',
      `UPDATE shift_assignments SET effective_from = CURRENT_DATE - 10 WHERE restaurant_id = '${me.restaurant.id}'`]);
  }

  // Boss sets one salary through the UI (Salaries sheet), the rest via API ---------
  await page.goto('/#/salaries');
  await expect(page.getByRole('heading', { level: 1, name: 'Salaries' })).toBeVisible();
  await expect(page.getByText('Salary not set').first()).toBeVisible();
  await page.getByRole('button', { name: /Siti Aminah/ }).click();
  const rateSheet = page.getByRole('dialog', { name: 'Siti Aminah' });
  await rateSheet.getByLabel(/Daily salary/).fill('150');
  await expect(rateSheet.getByText(/RM\s12\.50/)).toBeVisible(); // OT per hour = 150 / 12
  await shot(page, info, 'salary-sheet');
  await rateSheet.getByRole('button', { name: 'Save salary' }).click();
  await expect(rateSheet).toBeHidden();
  await call(req, 'PUT', `/api/employees/${ids['NK-02']}/rate`, { daily_rate: 180, effective_from: klDate(-10) });
  await call(req, 'PUT', `/api/employees/${ids['NK-03']}/rate`, { daily_rate: 120, effective_from: klDate(-10) });
  await call(req, 'PUT', `/api/employees/${ids['NK-01']}/rate`, { daily_rate: 150, effective_from: klDate(-10) });
  await expect(page.getByText(/RM\s150\.00/).first()).toBeVisible();
  await shot(page, info, 'salaries');

  // Attendance history (manual owner entries = check-outs create payouts) -----------
  const plan: [string, number, number][] = [
    // staff, minutes late, overtime minutes
    ['NK-01', 0, 75], ['NK-02', 2, 0], ['NK-03', 18, 30], ['NK-04', 0, 0],
  ];
  for (let day = -4; day <= -1; day++) {
    for (const [sid, late, ot] of plan) {
      if (sid === 'NK-03' && day === -2) continue; // a day off
      const lateBy = sid === 'NK-02' && day === -3 ? 25 : late;
      await call(req, 'POST', '/api/attendance/manual', { employee_id: ids[sid], action: 'check_in', time: kl(klDate(day), '08:00', lateBy), note: 'Test data (e2e)' });
      await call(req, 'POST', '/api/attendance/manual', { employee_id: ids[sid], action: 'check_out', time: kl(klDate(day), '20:00', ot), note: 'Test data (e2e)' });
    }
  }
  // Settle most of the history so the pending list is realistic.
  const pending = (await call(req, 'GET', '/api/payouts?status=pending&limit=500')).payouts as { id: string; employee_id: string; work_date: string; rate_missing: boolean }[];
  for (const p of pending) {
    if (p.rate_missing) continue;
    if (p.work_date <= klDate(-3)) await call(req, 'POST', `/api/payouts/${p.id}/pay`, { method: 'qr', note: 'Test data' });
  }

  // Pay screen -------------------------------------------------------------------
  await page.goto('/#/pay');
  await expect(page.getByRole('heading', { level: 1, name: 'Pay' })).toBeVisible();
  await expect(page.getByText('Outstanding')).toBeVisible();
  await expect(page.getByText(/can’t be calculated because a salary isn’t set/)).toBeVisible(); // Raj has no salary
  if (mobile) await expect(page.locator('.tabbar a[href="#/pay"] .tab-badge')).toBeVisible();
  await noOverflow(page, 'pay');
  await shot(page, info, 'pay');

  // Open Siti's most recent payout: 12 h salary + 1h15 OT at RM12.50/h = RM165.63
  await page.locator('.grow-row', { hasText: 'Siti' }).first().click();
  const sheet = page.getByRole('dialog', { name: 'Siti' });
  await expect(sheet.getByText(/RM\s165\.63/).first()).toBeVisible();
  await expect(sheet.getByText(/1h 15m × RM\s12\.50\/h/)).toBeVisible();
  await shot(page, info, 'payout-detail');

  // Cash requires the payslip photo
  await sheet.getByRole('button', { name: /^Cash/ }).click();
  const cashSheet = page.getByRole('dialog', { name: 'Paid in cash' });
  await expect(cashSheet.getByRole('button', { name: /Confirm RM\s165\.63/ })).toBeDisabled();
  await shot(page, info, 'pay-cash-camera');
  await cashSheet.locator('input[type=file][capture]').setInputFiles({ name: 'payslip.jpg', mimeType: 'image/jpeg', buffer: await payslipJpeg() });
  await expect(cashSheet.getByRole('img', { name: 'Payslip photo preview' })).toBeVisible();
  await cashSheet.getByLabel(/Note/).fill('Signed by Siti');
  await shot(page, info, 'pay-cash-photo');
  await cashSheet.getByRole('button', { name: /Confirm RM\s165\.63/ }).click();
  await expect(page.getByText(/Paid RM\s165\.63 in cash to Siti/)).toBeVisible();
  await expect(cashSheet).toBeHidden();

  // QR for Faizal
  await page.locator('.grow-row', { hasText: 'Faizal' }).first().click();
  const fSheet = page.getByRole('dialog', { name: 'Faizal' });
  await fSheet.getByRole('button', { name: /^QR/ }).click();
  await page.getByRole('dialog', { name: 'Paid via QR' }).getByRole('button', { name: /^Confirm/ }).click();
  await expect(page.getByText(/via QR to Faizal/)).toBeVisible();

  // Keep Mei Ling pending with a note
  await page.locator('.grow-row', { hasText: 'Mei Ling' }).first().click();
  await page.getByRole('dialog', { name: 'Mei Ling' }).getByRole('button', { name: /^Later/ }).click();
  const later = page.getByRole('dialog', { name: 'Keep pending' });
  await later.getByLabel(/Note/).fill('Pay on Friday');
  await later.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.grow-row', { hasText: 'Pay on Friday' })).toBeVisible();

  // Paid tab shows the proof
  await page.getByRole('group', { name: 'Show' }).getByRole('button', { name: 'Paid' }).click();
  await page.locator('.grow-row', { hasText: 'Siti' }).filter({ has: page.locator('.status-chip.cash') }).first().click();
  const paidSheet = page.getByRole('dialog', { name: 'Siti' });
  await expect(paidSheet.getByText('Paid in cash')).toBeVisible();
  await expect(paidSheet.getByRole('button', { name: 'View payment proof photo' })).toBeVisible();
  await shot(page, info, 'payout-paid');
  await paidSheet.getByRole('button', { name: 'Close' }).click();
  await shot(page, info, 'pay-paid-list');

  // Live alert: a check-out happening elsewhere pops a "RM… due · Pay" toast -----
  await page.getByRole('group', { name: 'Show' }).getByRole('button', { name: 'Pending' }).click();
  const other = await browser.newContext();
  const login = await other.request.post('/api/auth/login', { data: { email, password: 'e2e-password-123' } });
  expect(login.ok()).toBeTruthy();
  await call(other.request, 'POST', '/api/attendance/manual', { employee_id: ids['NK-01'], action: 'check_in', time: new Date(Date.now() - 12.5 * 3600_000).toISOString(), note: 'Test data (e2e)' });
  await call(other.request, 'POST', '/api/attendance/manual', { employee_id: ids['NK-01'], action: 'check_out', note: 'Test data (e2e)' });
  const toast = page.locator('.toast', { hasText: /Siti checked out · RM\s\d+\.\d\d due/ });
  await expect(toast).toBeVisible({ timeout: 15000 });
  await shot(page, info, 'pay-live-alert', { keepToasts: true });
  await toast.getByRole('button', { name: 'Pay' }).click();
  await expect(page.getByRole('dialog', { name: 'Siti' })).toBeVisible();
  await page.getByRole('dialog', { name: 'Siti' }).getByRole('button', { name: 'Close' }).click();
  await other.close();

  // Leaderboard + share image -------------------------------------------------------
  await page.goto('/#/leaderboard');
  await expect(page.getByRole('heading', { level: 1, name: 'Leaderboard' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Top three' })).toBeVisible();
  await noOverflow(page, 'leaderboard');
  await shot(page, info, 'leaderboard', { fullPage: true });
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  const share = page.getByRole('dialog', { name: 'Share leaderboard' });
  await expect(share.getByRole('img', { name: 'Leaderboard image preview' })).toBeVisible();
  await shot(page, info, 'leaderboard-share');
  if (info.project.name === 'desktop-light') {
    const dataUrl = await share.getByRole('img', { name: 'Leaderboard image preview' }).getAttribute('src');
    const png = Buffer.from(dataUrl!.split(',')[1], 'base64');
    await sharp(png).toFile(path.join(SHOTS, 'leaderboard-share-image.png'));
    const meta = await sharp(png).metadata();
    expect([meta.width, meta.height]).toEqual([1080, 1350]);
  }
  const [download] = await Promise.all([page.waitForEvent('download'), share.getByRole('button', { name: 'Save image' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^leaderboard-.*\.png$/);

  // Today screen with the new chrome, for the record
  await page.goto('/#/');
  await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
  await shot(page, info, 'today-glass');

  expect(errors, errors.join('\n')).toEqual([]);
});
