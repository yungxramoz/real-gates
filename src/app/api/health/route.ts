import { commitSha } from '@/lib/env';
import { assertStubTargets, isStubMode } from '@/lib/stub';
import { createSupabaseServerClient } from '@/lib/supabase/server';

/**
 * `GET /api/health` answers `{ commit, db }`. The loop polls it after a merge until `commit` is the
 * merged sha and `db` is `"ok"`, so both fields must tell the truth about *this* deployment, now.
 *
 * - `commit`: `VERCEL_GIT_COMMIT_SHA` (a Vercel system variable), or `"local"` off Vercel.
 * - `db`: `"ok"` after a real round trip to Postgres, `"down"` (503) when it fails or times out,
 *   `"stub"` in stub mode (`src/lib/stub.ts`), where no external service is contacted at all.
 *
 * The probe is the cheapest query that reaches Postgres on a project with no tables yet: listing
 * storage buckets runs `select … from storage.buckets` under RLS and, with the publishable key,
 * answers `[]` without reading a row. Once your first migration adds a table, swap it for
 * `supabase.from('<table>').select('id').limit(1)`: that also proves the Data API path and your
 * grants.
 *
 * Nothing from an error or the environment reaches the answer or the log: an error body can carry
 * a credential or personal data.
 */

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

/** A probe that hangs is a probe that failed. */
const PROBE_TIMEOUT_MS = 5_000;

type HealthBody = { commit: string; db: 'ok' | 'down' | 'stub' };

async function probeDatabase(): Promise<boolean> {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.storage.listBuckets();
  return error === null;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function GET(): Promise<Response> {
  const commit = commitSha();

  try {
    if (isStubMode()) {
      assertStubTargets();
      return Response.json({ commit, db: 'stub' } satisfies HealthBody, { headers: NO_STORE });
    }
    if (await withTimeout(probeDatabase(), PROBE_TIMEOUT_MS)) {
      return Response.json({ commit, db: 'ok' } satisfies HealthBody, { headers: NO_STORE });
    }
    console.error('[health] database probe returned an error');
  } catch {
    // Missing configuration, the network, a timeout or a stub pointed at a real service. The
    // caller gets the same answer for each: this deployment cannot vouch for its database.
    console.error('[health] database probe failed or timed out');
  }

  return Response.json({ commit, db: 'down' } satisfies HealthBody, {
    status: 503,
    headers: NO_STORE,
  });
}
