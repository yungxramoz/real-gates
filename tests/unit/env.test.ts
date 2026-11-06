import { afterEach, describe, expect, it, vi } from 'vitest';

import { appEnv, commitSha, publicEnv, serverEnv, siteUrl } from '@/lib/env';
import { assertStubTargets, isLoopbackUrl, isStubMode } from '@/lib/stub';

/**
 * AC-0.1 — environment access validates lazily, names the variable that is wrong and never
 * echoes a value, and stub mode can only be switched on deliberately and only against loopback.
 */

const SECRET = 'unit-sentinel-value-never-in-messages';

afterEach(() => {
  vi.unstubAllEnvs();
});

function errorOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected a throw');
}

describe('publicEnv', () => {
  it('AC-0.1 returns the public values with a trimmed site URL', () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://127.0.0.1:54321');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'pk');
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://app.example.com//');
    expect(publicEnv()).toEqual({
      supabaseUrl: 'http://127.0.0.1:54321',
      supabasePublishableKey: 'pk',
      siteUrl: 'https://app.example.com',
    });
  });

  it('AC-0.1 names a missing variable', () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '  ');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'pk');
    expect(errorOf(publicEnv)).toContain('NEXT_PUBLIC_SUPABASE_URL');
  });

  it('AC-0.1 names an invalid URL without echoing it', () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SECRET);
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'pk');
    const message = errorOf(publicEnv);
    expect(message).toContain('NEXT_PUBLIC_SUPABASE_URL');
    expect(message).not.toContain(SECRET);
  });
});

describe('serverEnv', () => {
  it('AC-0.1 treats blank values as unset', () => {
    expect(serverEnv({ SUPABASE_SECRET_KEY: ' ', EMAIL_API_KEY: '', NODE_ENV: 'test' })).toEqual({
      SUPABASE_SECRET_KEY: undefined,
      EMAIL_BASE_URL: undefined,
      EMAIL_API_KEY: undefined,
      STUB_MODE: undefined,
    });
  });

  it('AC-0.1 names an invalid EMAIL_BASE_URL without echoing it', () => {
    const message = errorOf(() => serverEnv({ EMAIL_BASE_URL: SECRET, NODE_ENV: 'test' }));
    expect(message).toContain('EMAIL_BASE_URL');
    expect(message).not.toContain(SECRET);
  });
});

describe('appEnv, commitSha, siteUrl', () => {
  it('AC-0.1 prefers APP_ENV, then VERCEL_ENV, then NODE_ENV', () => {
    expect(appEnv({ APP_ENV: 'preview', VERCEL_ENV: 'production', NODE_ENV: 'production' })).toBe(
      'preview',
    );
    expect(appEnv({ APP_ENV: ' ', VERCEL_ENV: 'preview', NODE_ENV: 'production' })).toBe('preview');
    expect(appEnv({ NODE_ENV: 'production' })).toBe('production');
  });

  it('AC-0.1 an unknown value falls back to development', () => {
    expect(appEnv({ APP_ENV: 'staging', NODE_ENV: 'test' })).toBe('development');
  });

  it('AC-0.1 commitSha falls back to local', () => {
    expect(commitSha({ NODE_ENV: 'test' })).toBe('local');
    expect(commitSha({ VERCEL_GIT_COMMIT_SHA: ' 0a1b2c ', NODE_ENV: 'test' })).toBe('0a1b2c');
  });

  it('AC-0.1 siteUrl defaults to localhost', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', '');
    expect(siteUrl()).toBe('http://localhost:3000');
  });
});

describe('stub mode', () => {
  const preview = { APP_ENV: 'preview', STUB_MODE: '1', NODE_ENV: 'production' } as const;

  it('AC-0.1 is on only with APP_ENV=preview and STUB_MODE=1', () => {
    expect(isStubMode(preview)).toBe(true);
    expect(isStubMode({ ...preview, STUB_MODE: '' })).toBe(false);
    expect(isStubMode({ ...preview, STUB_MODE: 'true' })).toBe(false);
    expect(isStubMode({ ...preview, APP_ENV: 'production' })).toBe(false);
    expect(isStubMode({ ...preview, APP_ENV: 'development' })).toBe(false);
  });

  it('AC-0.1 is never on for a Vercel production deployment', () => {
    expect(isStubMode({ ...preview, VERCEL_ENV: 'production' })).toBe(false);
  });

  it('AC-0.1 recognises loopback URLs only', () => {
    expect(isLoopbackUrl('http://127.0.0.1:54321')).toBe(true);
    expect(isLoopbackUrl('http://localhost:4000/v1')).toBe(true);
    expect(isLoopbackUrl('http://[::1]:4000')).toBe(true);
    expect(isLoopbackUrl('https://api.example.com')).toBe(false);
    expect(isLoopbackUrl('http://127.0.0.1.example.com')).toBe(false);
    expect(isLoopbackUrl('not a url')).toBe(false);
  });

  it('AC-0.1 refuses a non-loopback service URL by name, without its value', () => {
    const message = errorOf(() =>
      assertStubTargets({ ...preview, EMAIL_BASE_URL: 'https://mail.example.com' }),
    );
    expect(message).toContain('EMAIL_BASE_URL');
    expect(message).not.toContain('mail.example.com');
  });

  it('AC-0.1 accepts loopback and unset service URLs, and does nothing outside stub mode', () => {
    expect(() =>
      assertStubTargets({ ...preview, NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321' }),
    ).not.toThrow();
    expect(() => assertStubTargets(preview)).not.toThrow();
    expect(() =>
      assertStubTargets({ NODE_ENV: 'production', EMAIL_BASE_URL: 'https://mail.example.com' }),
    ).not.toThrow();
  });
});
