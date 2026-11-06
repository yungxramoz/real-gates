/**
 * Stub mode: the app runs as a real production build (`next build && next start`) while every
 * external service it talks to is either skipped or pointed at a local stand-in. That is what
 * lets the e2e suite run in CI with no Supabase project, no email provider and no secrets.
 *
 * Stub mode is on only when BOTH hold:
 *
 *   - `APP_ENV=preview`, and
 *   - `STUB_MODE=1`.
 *
 * `VERCEL_ENV=production` switches it off whatever else is set, so a stray variable on the
 * production deployment can never make it answer from a stub.
 *
 * In stub mode every configured service base URL must be a loopback address. A stub that quietly
 * talks to a real service is worse than no stub, so `assertStubTargets()` refuses it by name.
 * The service base URLs are `NEXT_PUBLIC_SUPABASE_URL` and, when the app sends email,
 * `EMAIL_BASE_URL`. A local stub process for either (a few routes answering what the feature
 * under test calls) is started by the e2e setup before `next build`, because `NEXT_PUBLIC_*`
 * values are inlined at build time.
 */

import { appEnv, serverEnv } from '@/lib/env';

/** The service base URLs stub mode checks, by variable name. */
const SERVICE_URLS = ['NEXT_PUBLIC_SUPABASE_URL', 'EMAIL_BASE_URL'] as const;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export function isStubMode(source: NodeJS.ProcessEnv = process.env): boolean {
  if (source.VERCEL_ENV?.trim() === 'production') return false;
  return appEnv(source) === 'preview' && serverEnv(source).STUB_MODE === '1';
}

/** True when `url` parses and its host is a loopback address. */
export function isLoopbackUrl(url: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * Throws when stub mode is on and a configured service URL is not loopback. The message names the
 * variable, never its value.
 */
export function assertStubTargets(source: NodeJS.ProcessEnv = process.env): void {
  if (!isStubMode(source)) return;
  for (const name of SERVICE_URLS) {
    const value = source[name]?.trim();
    if (value === undefined || value === '') continue;
    if (!isLoopbackUrl(value)) {
      throw new Error(
        `Stub mode is on but ${name} is not a loopback URL. Point it at a local stub ` +
          '(http://127.0.0.1:<port>) or turn stub mode off.',
      );
    }
  }
}
