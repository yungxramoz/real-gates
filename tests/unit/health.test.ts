import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * AC-0.1 — `GET /api/health` answers `{ commit, db }` and nothing else: `ok` after a database
 * round trip, `down` (503) when it fails, throws or hangs, `stub` in stub mode without touching
 * the network. No env value and no error text reaches the answer or the log.
 */

const SECRET = 'unit-sentinel-secret-key-never-in-output';

const probe = vi.hoisted(() => ({
  calls: 0,
  mode: 'ok' as 'ok' | 'error' | 'throws' | 'hangs',
}));

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: async () => {
    if (probe.mode === 'throws') {
      throw new Error(`Missing environment variable, key=${SECRET}`);
    }
    return {
      storage: {
        listBuckets: () => {
          probe.calls += 1;
          if (probe.mode === 'hangs') return new Promise(() => {});
          return Promise.resolve(
            probe.mode === 'ok'
              ? { data: [], error: null }
              : { data: null, error: { message: `connection refused for ${SECRET}` } },
          );
        },
      },
    };
  },
}));

const { GET } = await import('@/app/api/health/route');

beforeEach(() => {
  probe.calls = 0;
  probe.mode = 'ok';
  vi.stubEnv('VERCEL_GIT_COMMIT_SHA', 'abc1234');
  vi.stubEnv('APP_ENV', 'production');
  vi.stubEnv('VERCEL_ENV', '');
  vi.stubEnv('STUB_MODE', '');
  vi.stubEnv('SUPABASE_SECRET_KEY', SECRET);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function read(response: Response) {
  const text = await response.text();
  expect(text).not.toContain(SECRET);
  return JSON.parse(text) as unknown;
}

function logged(): string {
  return JSON.stringify(vi.mocked(console.error).mock.calls);
}

describe('GET /api/health', () => {
  it('AC-0.1 answers 200 with commit and db ok after one probe, never cached', async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await read(response)).toEqual({ commit: 'abc1234', db: 'ok' });
    expect(probe.calls).toBe(1);
  });

  it('AC-0.1 falls back to commit "local" off Vercel', async () => {
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', '');
    expect(await read(await GET())).toEqual({ commit: 'local', db: 'ok' });
  });

  it('AC-0.1 a probe error is 503 db down, and the error text is not logged', async () => {
    probe.mode = 'error';
    const response = await GET();
    expect(response.status).toBe(503);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await read(response)).toEqual({ commit: 'abc1234', db: 'down' });
    expect(logged()).not.toContain(SECRET);
  });

  it('AC-0.1 a client that cannot be built is 503 db down, without the reason', async () => {
    probe.mode = 'throws';
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await read(response)).toEqual({ commit: 'abc1234', db: 'down' });
    expect(logged()).not.toContain(SECRET);
  });

  it('AC-0.1 a probe that hangs is 503 db down after the timeout', async () => {
    vi.useFakeTimers();
    probe.mode = 'hangs';
    const pending = GET();
    await vi.advanceTimersByTimeAsync(5_000);
    const response = await pending;
    expect(response.status).toBe(503);
    expect(await read(response)).toEqual({ commit: 'abc1234', db: 'down' });
  });

  it('AC-0.1 stub mode answers db stub without probing', async () => {
    vi.stubEnv('APP_ENV', 'preview');
    vi.stubEnv('STUB_MODE', '1');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://127.0.0.1:54321');
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await read(response)).toEqual({ commit: 'abc1234', db: 'stub' });
    expect(probe.calls).toBe(0);
  });

  it('AC-0.1 stub mode pointed at a real service is 503 db down', async () => {
    vi.stubEnv('APP_ENV', 'preview');
    vi.stubEnv('STUB_MODE', '1');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://project.supabase.example.com');
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await read(response)).toEqual({ commit: 'abc1234', db: 'down' });
    expect(probe.calls).toBe(0);
  });

  it('AC-0.1 STUB_MODE without APP_ENV=preview is ignored and the database is probed', async () => {
    vi.stubEnv('STUB_MODE', '1');
    expect(await read(await GET())).toEqual({ commit: 'abc1234', db: 'ok' });
    expect(probe.calls).toBe(1);
  });
});
