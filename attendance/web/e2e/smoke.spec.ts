import { test, expect, request as pwRequest, type Page, type TestInfo } from '@playwright/test';
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const SHOTS = path.resolve(process.cwd(), '../docs/screenshots');
mkdirSync(SHOTS, { recursive: true });

function variant(info: TestInfo) {
  const [size, scheme] = info.project.name.split('-');
  return { size, scheme, mobile: size === 'mobile' };
}

async function shot(page: Page, info: TestInfo, name: string, fullPage = false) {
  const { size, scheme } = variant(info);
  // Dismiss transient toasts so they don't cover the screen being documented.
  for (const b of await page.locator('.toast-close').all()) await b.click({ timeout: 1000 }).catch(() => {});
  await page.waitForTimeout(400); // let skeletons settle / animations finish
  await page.screenshot({ path: path.join(SHOTS, `pwa-${size}-${name}-${scheme}.png`), fullPage });
}

async function expectNoHorizontalOverflow(page: Page, where: string) {
  const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  expect(sw, `horizontal overflow on ${where}`).toBeLessThanOrEqual(cw);
}

async function go(page: Page, hash: string, ready: RegExp | string) {
  await page.goto(`/#${hash}`);
  await expect(page.getByRole('heading', { level: 1, name: ready })).toBeVisible();
}

test('owner flow: signup → staff/shift → kiosk pairing → manual check-in → realtime feed → insights CSV', async ({ page, baseURL }, info) => {
  const { mobile } = variant(info);
  const consoleErrors: string[] = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const loc = m.location()?.url ?? '';
    // The only expected error: the browser logs the 401 from GET /api/auth/me before signing in.
    if (/status of 401/.test(m.text()) && loc.endsWith('/api/auth/me')) return;
    consoleErrors.push(`${m.text()} @ ${loc}`);
  });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

  const email = `e2e+${info.project.name}-${Date.now()}@demo-bistro.test`;
  const password = 'e2e-password-123';

  // 1. Sign up -----------------------------------------------------------
  await page.goto('/#/signup');
  await expect(page.getByRole('heading', { name: 'Create your restaurant' })).toBeVisible();
  await shot(page, info, 'signup');
  await page.getByLabel('Restaurant name').fill(`E2E Bistro (test data) ${info.project.name}`);
  await page.getByLabel('Your name').fill('Eve Tester');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
  await expect(page.locator('.conn.live')).toBeVisible();

  // 2. Create a shift --------------------------------------------------
  await go(page, '/shifts', 'Shifts');
  await page.getByRole('button', { name: 'New shift' }).click();
  const shiftDialog = page.getByRole('dialog', { name: 'New shift' });
  await shiftDialog.getByLabel('Name').fill('Morning (test)');
  await shiftDialog.getByLabel('Starts').fill('08:00');
  await shiftDialog.getByLabel('Ends').fill('16:00');
  for (const d of ['Sat', 'Sun']) await shiftDialog.getByRole('button', { name: d, exact: true }).click();
  await shiftDialog.getByRole('button', { name: 'Create shift' }).click();
  await expect(shiftDialog).toBeHidden();
  await expect(page.getByText('Morning (test)').filter({ visible: true }).first()).toBeVisible();
  await shot(page, info, 'shifts');

  // 3. Add an employee with the shift -----------------------------------
  await go(page, '/staff', 'Staff');
  await page.getByRole('button', { name: 'Add employee', exact: true }).click();
  const empDialog = page.getByRole('dialog', { name: 'Add employee' });
  await empDialog.getByLabel('Full name').fill('Siti Aminah');
  await empDialog.getByLabel('Staff ID').fill('E2E-1');
  await empDialog.getByLabel('Job title').fill('Server');
  await empDialog.getByRole('button', { name: /Morning \(test\)/ }).click();
  await shot(page, info, 'add-employee');
  await empDialog.getByRole('button', { name: 'Add employee' }).click();
  await expect(page.getByRole('heading', { level: 1, name: /Siti Aminah/ })).toBeVisible();

  // 4. Owner-assisted manual check-in -------------------------------------
  await page.getByRole('button', { name: 'Check in', exact: true }).click();
  const manual = page.getByRole('dialog', { name: 'Record attendance manually' });
  await manual.getByLabel('Reason').fill('E2E: kiosk not installed yet');
  await manual.getByRole('button', { name: 'Record check-in' }).click();
  await expect(manual).toBeHidden();
  await expect(page.getByText(/Siti Aminah: checked in at/)).toBeVisible();
  await expect(page.getByText(/Working since/)).toBeVisible();
  await shot(page, info, 'employee');

  // 5. Kiosk pairing code ------------------------------------------------
  await go(page, '/devices', 'Kiosks');
  await page.getByRole('button', { name: 'Add kiosk', exact: true }).click();
  await page.getByRole('dialog', { name: 'Add a kiosk' }).getByRole('button', { name: 'Create pairing code' }).click();
  const pairing = page.getByRole('dialog', { name: 'Pair your kiosk' });
  await expect(pairing.locator('.pair-code')).toHaveText(/^[A-Z0-9]{3}-[A-Z0-9]{3}-[A-Z0-9]{3}$/);
  await expect(pairing.getByText(/Expires in \d+:\d\d/)).toBeVisible();
  await expect(pairing.getByText(baseURL!)).toBeVisible();
  await shot(page, info, 'kiosk-pairing');
  await pairing.getByRole('button', { name: 'Done' }).click();

  // 6. Live feed updates via SSE without reload ---------------------------
  // On phones the owner's tab bar shows Pay instead of Live, so the feed is reached via More.
  if (mobile) {
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'More' }).click();
    await page.getByRole('link', { name: /Live feed/ }).click();
  }
  else await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Live feed' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Live feed' })).toBeVisible();
  await expect(page.locator('.feed-item', { hasText: 'Siti Aminah' })).toBeVisible();
  await page.evaluate(() => ((window as unknown as { __noReload: number }).__noReload = 42));

  // A second event created from OUTSIDE the page (separate API session).
  const outside = await pwRequest.newContext({ baseURL, extraHTTPHeaders: { 'X-CSRF': '1' } });
  expect((await outside.post('/api/auth/login', { data: { email, password } })).ok()).toBeTruthy();
  const created = await outside.post('/api/employees', { data: { full_name: 'Omar Outside', staff_id: 'E2E-2' } });
  expect(created.status()).toBe(201);
  const { employee } = await created.json();
  const ev = await outside.post('/api/attendance/manual', { data: { employee_id: employee.id, action: 'check_in', note: 'E2E: created from outside the page' } });
  expect(ev.status()).toBe(201);
  await outside.dispose();

  await expect(page.locator('.feed-item', { hasText: 'Omar Outside' })).toBeVisible({ timeout: 15_000 });
  expect(await page.evaluate(() => (window as unknown as { __noReload?: number }).__noReload)).toBe(42);
  await expect(page.locator('.feed-item').first()).toContainText('Omar Outside'); // newest first
  await shot(page, info, 'live');

  // Event detail sheet: distinct "Manual" badge, never "Verified".
  await page.locator('.feed-item', { hasText: 'Omar Outside' }).click();
  const sheet = page.getByRole('dialog', { name: 'Check-in' });
  await expect(sheet.getByText('Manual', { exact: true }).first()).toBeVisible();
  await shot(page, info, 'event-detail');
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();

  // 7. Today, timesheets, alerts, settings render with data ----------------
  await go(page, '/', 'Today');
  await expect(page.locator('.roster-item', { hasText: 'Siti Aminah' })).toBeVisible();
  await shot(page, info, 'today');
  if (mobile) await expectNoHorizontalOverflow(page, 'today');
  await go(page, '/attendance', 'Timesheets');
  await expect(page.getByText('Omar Outside').filter({ visible: true }).first()).toBeVisible();
  await shot(page, info, 'timesheets');
  if (mobile) await expectNoHorizontalOverflow(page, 'timesheets');
  await go(page, '/alerts', 'Alerts');
  await shot(page, info, 'alerts');
  await go(page, '/settings/kiosk', 'Kiosk & recognition');
  await page.getByLabel('Match threshold').fill('0.4');
  await expect(page.getByText(/wrong person/)).toBeVisible();
  await shot(page, info, 'settings-kiosk');
  if (mobile) {
    await go(page, '/more', 'More');
    await shot(page, info, 'more');
  }

  // 8. Insights + CSV download --------------------------------------------
  await go(page, '/insights', 'Insights');
  await expect(page.getByText('Hours worked')).toBeVisible();
  await expect(page.getByText(/provisional/i).filter({ visible: true }).first()).toBeVisible();
  await shot(page, info, 'insights');
  if (mobile) await expectNoHorizontalOverflow(page, 'insights');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Timesheet CSV/ }).click()]);
  expect(download.suggestedFilename()).toMatch(/^timesheet-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.csv$/);
  const csv = readFileSync((await download.path())!, 'utf8');
  expect(csv).toContain('PROVISIONAL');
  expect(csv).toContain('Siti Aminah');

  // Every screen visited at 390px must not scroll horizontally.
  for (const h of ['/live', '/staff', '/devices', '/shifts', '/settings']) {
    await page.goto(`/#${h}`);
    await page.waitForTimeout(600);
    if (mobile) await expectNoHorizontalOverflow(page, h);
  }

  expect(consoleErrors, consoleErrors.join('\n')).toEqual([]);
});
