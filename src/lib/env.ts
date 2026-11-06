/**
 * Environment access, validated with Zod.
 *
 * Three properties this module has on purpose:
 *
 * 1. **Two halves.** `publicEnv()` holds only `NEXT_PUBLIC_*` values, which Next.js inlines into
 *    the browser bundle. `serverEnv()` holds everything else, including the server-only keys.
 *    A server-only key is never named `NEXT_PUBLIC_*`: that prefix is what ships a value to every
 *    browser. CI builds with sentinel keys and greps `.next/static` for them to prove it.
 * 2. **Validation is lazy.** A fresh clone with only `.env.example` copied must still pass
 *    `pnpm build`, and those values are empty. Parsing at module load would fail the build;
 *    parsing when a value is first needed fails that request instead, naming the variable.
 * 3. **`NEXT_PUBLIC_*` reads are written out literally.** Next.js inlines them by textual
 *    substitution of `process.env.NEXT_PUBLIC_X`; iterating over `process.env` would compile to
 *    `undefined` in the browser.
 */

import { z } from 'zod';

const appEnvSchema = z.enum(['development', 'preview', 'production']);

export type AppEnv = z.infer<typeof appEnvSchema>;

/** A variable created but left blank counts as unset. */
const optional = z
  .string()
  .optional()
  .transform((value) => {
    const trimmed = value?.trim();
    return trimmed === undefined || trimmed === '' ? undefined : trimmed;
  });

const required = (name: string) =>
  z
    .string({ error: () => missing(name) })
    .trim()
    .min(1, { error: () => missing(name) });

const optionalUrl = (name: string) =>
  optional.pipe(z.url({ error: () => `${name} is not a valid URL.` }).optional());

function missing(name: string): string {
  return (
    `Missing environment variable ${name}. Copy .env.example to .env.local and fill it in; ` +
    'on Vercel, set it for the matching environment.'
  );
}

const publicSchema = z.object({
  supabaseUrl: required('NEXT_PUBLIC_SUPABASE_URL').pipe(
    z.url({ error: () => 'NEXT_PUBLIC_SUPABASE_URL is not a valid URL.' }),
  ),
  supabasePublishableKey: required('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY'),
});

export type PublicEnv = z.infer<typeof publicSchema> & { siteUrl: string };

/** Safe in the browser. The publishable key is public by design; RLS is what protects the data. */
export function publicEnv(): PublicEnv {
  const parsed = publicSchema.safeParse({
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
    supabasePublishableKey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  });
  if (!parsed.success) throw new Error(firstIssue(parsed.error));
  return { ...parsed.data, siteUrl: siteUrl() };
}

const serverSchema = z.object({
  /** Supabase secret key (or the legacy service-role key). Bypasses RLS: server code only. */
  SUPABASE_SECRET_KEY: optional,
  /** Base URL of the email provider's HTTP API. In stub mode it points at a local stub. */
  EMAIL_BASE_URL: optionalUrl('EMAIL_BASE_URL'),
  /** API key for that provider. Server code only. */
  EMAIL_API_KEY: optional,
  /** `1` turns on stub mode, but only together with `APP_ENV=preview` (see `src/lib/stub.ts`). */
  STUB_MODE: optional,
});

export type ServerEnv = z.infer<typeof serverSchema>;

/**
 * Server-only values. Never call this from a Client Component: outside `NEXT_PUBLIC_*` the
 * browser sees `undefined` for every variable, and the secret keys must not travel there anyway.
 */
export function serverEnv(source: NodeJS.ProcessEnv = process.env): ServerEnv {
  const parsed = serverSchema.safeParse({
    SUPABASE_SECRET_KEY: source.SUPABASE_SECRET_KEY,
    EMAIL_BASE_URL: source.EMAIL_BASE_URL,
    EMAIL_API_KEY: source.EMAIL_API_KEY,
    STUB_MODE: source.STUB_MODE,
  });
  if (!parsed.success) throw new Error(firstIssue(parsed.error));
  return parsed.data;
}

/** The canonical origin of this deployment, without a trailing slash. */
export function siteUrl(): string {
  const value = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  return (value === undefined || value === '' ? 'http://localhost:3000' : value).replace(
    /\/+$/,
    '',
  );
}

/**
 * Which deployment this is. The order is load-bearing: `VERCEL_ENV` is Vercel's own system
 * variable (`production` for the production branch, `preview` for every other) and comes before
 * `NODE_ENV`, because Vercel builds *every* deployment with `NODE_ENV=production`. An unknown
 * value falls back to `development`, the one that grants nothing.
 */
export function appEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const value = [source.APP_ENV, source.VERCEL_ENV, source.NODE_ENV]
    .map((candidate) => candidate?.trim())
    .find((candidate) => candidate !== undefined && candidate !== '');
  const parsed = appEnvSchema.safeParse(value);
  return parsed.success ? parsed.data : 'development';
}

/** The commit this deployment was built from. Never throws: a probe must always answer. */
export function commitSha(source: NodeJS.ProcessEnv = process.env): string {
  const value = source.VERCEL_GIT_COMMIT_SHA?.trim();
  return value === undefined || value === '' ? 'local' : value;
}

/** Only the message, never the input: an env value can be a credential. */
function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? 'Invalid environment.';
}
