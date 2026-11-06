import { defineConfig, devices } from '@playwright/test';

/**
 * Two ways to run the suite:
 *
 * - **Local production build (default, and CI).** Run `pnpm build` first; Playwright then starts
 *   `next start` on E2E_PORT in stub mode (`APP_ENV=preview`, `STUB_MODE=1`, see
 *   `src/lib/stub.ts`), so no external service is contacted.
 * - **A deployed target.** `E2E_BASE_URL=https://… pnpm test:e2e` runs against that URL and starts
 *   no server. Before trusting a green run there, fetch the page and check it is really yours.
 */
const externalBaseUrl = process.env.E2E_BASE_URL?.trim() || undefined;
// An unusual port, so another local server cannot answer in this one's place.
const port = Number(process.env.E2E_PORT?.trim() || 4791);
const baseURL = externalBaseUrl ?? `http://127.0.0.1:${port}`;
const isCI = process.env.CI !== undefined && process.env.CI !== '';

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: 'artifacts/playwright-output',
  forbidOnly: isCI,
  // One retry in CI absorbs a flaky network hop; locally a retry would hide a real failure.
  retries: isCI ? 1 : 0,
  ...(isCI ? { workers: 2 } : {}),
  expect: { timeout: 5_000 },
  reporter: [['list'], ['html', { outputFolder: 'artifacts/playwright-report', open: 'never' }]],
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    // The specs assert the page's resting state; motion is decoration.
    reducedMotion: 'reduce',
  },
  projects: [
    // Mobile first: 360 px is the floor every screen must work at.
    {
      name: 'mobile-360',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 360, height: 780 },
        deviceScaleFactor: 2,
      },
    },
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
  ],
  ...(externalBaseUrl === undefined
    ? {
        webServer: {
          command: `pnpm exec next start -p ${port}`,
          url: `${baseURL}/api/health`,
          reuseExistingServer: !isCI,
          timeout: 120_000,
          env: { APP_ENV: 'preview', STUB_MODE: '1' },
        },
      }
    : {}),
});
