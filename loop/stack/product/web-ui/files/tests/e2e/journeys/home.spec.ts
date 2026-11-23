import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

/**
 * AC-0.1: the skeleton serves a production build. The home page renders with one heading, nothing
 * scrolls sideways and there are no accessibility violations.
 *
 * Test titles start with the AC ID they prove; `pnpm ac-trace` reads them.
 */

const WCAG_22_AA = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

test('AC-0.1 home renders', async ({ page }) => {
  const response = await page.goto('/');
  expect(response?.status()).toBe(200);
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(page.locator('html')).toHaveAttribute('lang', /.+/);

  // Mobile first: nothing may scroll sideways, at 360 px included.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test('AC-0.1 home has no axe violations (WCAG 2.2 AA)', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const results = await new AxeBuilder({ page }).withTags(WCAG_22_AA).analyze();
  expect(results.violations.map((violation) => violation.id)).toEqual([]);
});
