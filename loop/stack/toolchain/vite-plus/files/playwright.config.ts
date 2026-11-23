import fs from 'node:fs';

import { defineConfig, devices } from '@playwright/test';

/**
 * Two ways to run the suite:
 *
 * - **Local production build (default, and CI).** Run `pnpm build` first; Playwright then starts
 *   it with `pnpm start` on E2E_PORT, when the project has something to start.
 * - **A deployed target.** `E2E_BASE_URL=https://… pnpm test:e2e` runs against that URL and starts
 *   no server. Before trusting a green run there, fetch a page and check it is really yours.
 *
 * Screens are tested in `tests/e2e/journeys/`, endpoints in `tests/e2e/api/`.
 */
const externalBaseUrl = process.env.E2E_BASE_URL?.trim() || undefined;
// An unusual port, so another local server cannot answer in this one's place.
const port = Number(process.env.E2E_PORT?.trim() || 4791);
const baseURL = externalBaseUrl ?? `http://127.0.0.1:${port}`;
const isCI = process.env.CI !== undefined && process.env.CI !== '';
// A project with nothing to start (a library) has no server to wait for.
const scripts: Record<string, string> = JSON.parse(fs.readFileSync('package.json', 'utf8')).scripts;
const starts = ['start:server', 'start:web'].some((name) => name in scripts);
// What tells that it is up: a server answers its health endpoint, a web app alone serves its page.
const ready = 'start:server' in scripts ? '/api/health' : '/';

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: 'artifacts/playwright-output',
  forbidOnly: isCI,
  // One retry in CI absorbs a flaky network hop; locally a retry would hide a real failure.
  retries: isCI ? 1 : 0,
  ...(isCI ? { workers: 2 } : {}),
  expect: { timeout: 5_000 },
  // The JUnit report is the evidence `pnpm ac-trace --results artifacts/junit` reads in CI.
  reporter: [
    ['list'],
    ['html', { outputFolder: 'artifacts/playwright-report', open: 'never' }],
    ['junit', { outputFile: 'artifacts/junit/e2e.xml' }],
  ],
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
  ...(externalBaseUrl === undefined && starts
    ? {
        webServer: {
          command: 'pnpm start',
          url: `${baseURL}${ready}`,
          reuseExistingServer: !isCI,
          timeout: 120_000,
          env: { PORT: String(port) },
        },
      }
    : {}),
});
