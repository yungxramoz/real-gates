import { expect, test } from '@playwright/test';

/**
 * AC-0.2: the skeleton's server answers. Endpoint tests call the real server over HTTP, the one
 * `pnpm start` runs, and check the status, the headers that matter and the body.
 *
 * Test titles start with the AC ID they prove; `pnpm ac-trace` reads them.
 */

test('AC-0.2 health answers', async ({ request }) => {
  const response = await request.get('/api/health');
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('application/json');
  expect(await response.json()).toEqual({ status: 'ok', commit: expect.any(String) });
});

test('AC-0.2 an unknown endpoint is a 404 with a JSON body', async ({ request }) => {
  const response = await request.get('/api/no-such-endpoint');
  expect(response.status()).toBe(404);
  expect(response.headers()['content-type']).toContain('application/json');
});
