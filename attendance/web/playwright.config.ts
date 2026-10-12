import { defineConfig } from '@playwright/test';

/**
 * Runs against a REAL backend that serves web/dist (strict CSP applies), e.g.:
 *   BASE_URL=http://localhost:8090 npm run e2e
 */
const baseURL = process.env.BASE_URL ?? 'http://localhost:8090';
const mobile = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
const desktop = { viewport: { width: 1440, height: 900 } };

export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL, locale: 'en-MY', timezoneId: 'Asia/Kuala_Lumpur', acceptDownloads: true, trace: 'retain-on-failure' },
  projects: [
    { name: 'mobile-light', use: { ...mobile, colorScheme: 'light' } },
    { name: 'mobile-dark', use: { ...mobile, colorScheme: 'dark' } },
    { name: 'desktop-light', use: { ...desktop, colorScheme: 'light' } },
    { name: 'desktop-dark', use: { ...desktop, colorScheme: 'dark' } },
  ],
});
