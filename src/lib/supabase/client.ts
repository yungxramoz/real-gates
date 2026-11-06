/**
 * Browser Supabase client for Client Components. Publishable key only, so RLS decides what it may
 * read and write. One instance per tab: `createBrowserClient` already caches it.
 */

import { createBrowserClient } from '@supabase/ssr';
import { publicEnv } from '@/lib/env';

export function createSupabaseBrowserClient() {
  const { supabaseUrl, supabasePublishableKey } = publicEnv();
  return createBrowserClient(supabaseUrl, supabasePublishableKey);
}
