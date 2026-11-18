import { defineConfig, devices } from '@playwright/test';

/**
 * Phone-sized journeys in a real browser against a real API, worker and in-memory MongoDB
 * (global-setup.js). One worker: the journeys share one database.
 */
export default defineConfig({
  testDir: './tests',
  globalSetup: './global-setup.js',
  globalTeardown: './global-teardown.js',
  timeout: 180_000,
  expect: { timeout: 15_000 },
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  outputDir: './test-results',
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: './playwright-report' }]] : 'list',
  use: {
    ...devices['Pixel 5'],
    baseURL: 'http://localhost:4173',
    browserName: 'chromium',
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
    acceptDownloads: true,
    trace: 'retain-on-failure',
  },
});
