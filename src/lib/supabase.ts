import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { mockClient } from '../utils/supabase/mockClient';
import { isMisconfiguredProduction, MISCONFIGURED_MESSAGE, supabaseUrl } from './supabaseConfig';

/**
 * SERVER-ONLY service-role client. It bypasses RLS, so API routes may use it only AFTER the
 * caller's access check (src/lib/auth.ts); the pipeline and the ingestion webhooks use it directly.
 * Never import this module from a client component ('use client'): the service key is not a
 * NEXT_PUBLIC_* variable, so it is never inlined into browser bundles, and the guard below throws
 * if the module is ever evaluated in a browser.
 */

if (typeof window !== 'undefined') {
  throw new Error('@/lib/supabase is server-only (service-role client). Use @/utils/supabase/client in the browser.');
}

const url = process.env.SUPABASE_URL || supabaseUrl();
const serviceKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
// Legacy fallback (anon key) for setups without a service key. Since the auth_tenancy migration
// anon has no access, so production must set SUPABASE_SERVICE_KEY.
const key = serviceKey ||
            process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
            process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const isConfigured = !!url && url !== 'https://placeholder-url.supabase.co' && !!key && key !== 'placeholder-key';

/** A client that refuses every use: production without Supabase env must not fall back to the mock DB. */
function failClosedClient(): SupabaseClient {
  return new Proxy({} as SupabaseClient, {
    get() {
      throw new Error(MISCONFIGURED_MESSAGE);
    },
  });
}

if (!isConfigured) {
  if (isMisconfiguredProduction()) {
    console.error(`[supabase] ${MISCONFIGURED_MESSAGE}`);
  } else {
    console.warn('Supabase URL or Key is missing. Database operations will use Local Mock Database.');
  }
} else if (!serviceKey && process.env.NODE_ENV === 'production') {
  console.error('[supabase] SUPABASE_SERVICE_KEY is missing: server-side database access will be denied by RLS.');
}

export const supabase: SupabaseClient = isConfigured
  ? createClient(url!, key!, { auth: { persistSession: false, autoRefreshToken: false } })
  : isMisconfiguredProduction()
    ? failClosedClient()
    : (mockClient as unknown as SupabaseClient);
