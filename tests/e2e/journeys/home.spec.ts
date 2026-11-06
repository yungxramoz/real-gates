import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { messages } from '../../../src/i18n/messages';

/**
 * AC-0.1: the skeleton serves a production build. The home page renders its copy with no
 * accessibility violations, and `/api/health` answers `{ commit, db }`.
 *
 * Test titles start with the AC ID they prove; `pnpm ac-trace` reads them.
 */

const WCAG_22_AA = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

test('AC-0.1 home renders', async ({ page }) => {
  const response = await page.goto('/');
  expect(response?.status()).toBe(200);
  await expect(page).toHaveTitle(messages.meta.title);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(messages.home.title);
  await expect(page.locator('html')).toHaveAttribute('lang', messages.meta.lang);

  // Mobile first: nothing may scroll sideways, at 360 px included.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test('AC-0.1 home has no axe violations (WCAG 2.2 AA)', async ({ page }) => {
  await page.goto('/');
  const results = await new AxeBuilder({ page }).withTags(WCAG_22_AA).analyze();
  expect(results.violations.map((violation) => violation.id)).toEqual([]);
});

test('AC-0.1 health answers commit and db', async ({ request }) => {
  const response = await request.get('/api/health');
  expect(response.status()).toBe(200);
  expect(response.headers()['cache-control']).toBe('no-store');

  const body = (await response.json()) as Record<string, unknown>;
  expect(Object.keys(body).sort()).toEqual(['commit', 'db']);
  expect(typeof body.commit).toBe('string');
  // `stub` against the local build in stub mode; `ok` against a deployment with a database.
  expect(['ok', 'stub']).toContain(body.db);
});
