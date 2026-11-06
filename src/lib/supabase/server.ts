import 'server-only';

/**
 * Request-scoped Supabase client for Server Components, Server Actions and route handlers.
 *
 * It uses the publishable key, so every read and write goes through RLS: the blast radius of a
 * mistake here is one policy, not the whole database. A client with the secret key bypasses RLS;
 * if you add one, give it its own module and keep its callers to route handlers and Server
 * Actions.
 */

import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { publicEnv } from '@/lib/env';

/** One client per request. `cookies()` is async in the App Router, so this is too. */
export async function createSupabaseServerClient() {
  const { supabaseUrl, supabasePublishableKey } = publicEnv();
  const cookieStore = await cookies();

  return createServerClient(supabaseUrl, supabasePublishableKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        // Server Components cannot set cookies; route handlers and Server Actions can. Swallowing
        // the error is correct here: a session refresh belongs in middleware (`src/proxy.ts`)
        // once the app has sign-in.
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a Server Component: nothing to persist.
        }
      },
    },
  });
}
