import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * AC-0.1 — both Supabase clients are built from the public values only (the publishable key, so
 * RLS applies), and the server client reads and writes the request's cookies.
 */

const calls = vi.hoisted(() => ({
  server: [] as unknown[][],
  browser: [] as unknown[][],
  set: [] as unknown[][],
  setThrows: false,
}));

vi.mock('@supabase/ssr', () => ({
  createServerClient: (...args: unknown[]) => {
    calls.server.push(args);
    return { kind: 'server' };
  },
  createBrowserClient: (...args: unknown[]) => {
    calls.browser.push(args);
    return { kind: 'browser' };
  },
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    getAll: () => [{ name: 'sb', value: 'session' }],
    set: (...args: unknown[]) => {
      if (calls.setThrows) throw new Error('Cookies can only be modified in a Server Action');
      calls.set.push(args);
    },
  }),
}));

const { createSupabaseServerClient } = await import('@/lib/supabase/server');
const { createSupabaseBrowserClient } = await import('@/lib/supabase/client');

type CookieAdapter = {
  getAll: () => unknown;
  setAll: (cookies: { name: string; value: string; options: object }[]) => void;
};

beforeEach(() => {
  calls.server = [];
  calls.browser = [];
  calls.set = [];
  calls.setThrows = false;
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://127.0.0.1:54321');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'publishable');
  vi.stubEnv('SUPABASE_SECRET_KEY', 'secret-must-not-be-used');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('Supabase clients', () => {
  it('AC-0.1 the server client uses the publishable key and the request cookies', async () => {
    await createSupabaseServerClient();
    const [url, key, options] = calls.server[0] as [string, string, { cookies: CookieAdapter }];
    expect(url).toBe('http://127.0.0.1:54321');
    expect(key).toBe('publishable');
    expect(options.cookies.getAll()).toEqual([{ name: 'sb', value: 'session' }]);

    options.cookies.setAll([{ name: 'sb', value: 'next', options: { path: '/' } }]);
    expect(calls.set).toEqual([['sb', 'next', { path: '/' }]]);
  });

  it('AC-0.1 the server client ignores a cookie write from a Server Component', async () => {
    await createSupabaseServerClient();
    const [, , options] = calls.server[0] as [string, string, { cookies: CookieAdapter }];
    calls.setThrows = true;
    expect(() => options.cookies.setAll([{ name: 'sb', value: 'x', options: {} }])).not.toThrow();
  });

  it('AC-0.1 the browser client uses the publishable key', () => {
    createSupabaseBrowserClient();
    expect(calls.browser).toEqual([['http://127.0.0.1:54321', 'publishable']]);
  });
});
