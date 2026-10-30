import { createBrowserClient } from '@supabase/ssr';
import { mockClient } from './mockClient';
import { isSupabaseConfigured, supabaseAnonKey, supabaseUrl } from '@/lib/supabaseConfig';

/**
 * Browser Supabase client. Anon key + the signed-in user's cookie session (set by /login, refreshed
 * by src/proxy.ts), so every query runs as `authenticated` and RLS scopes it to the user's
 * organizations. Never uses the service key. Local mock DB when Supabase isn't configured (outside
 * production the proxy lets the dashboard run without login; in production it refuses to serve).
 */
export const createClient = () => {
  if (!isSupabaseConfigured()) {
    return mockClient as unknown as ReturnType<typeof createBrowserClient>;
  }
  // createBrowserClient memoizes a singleton in the browser, so calling this per render is cheap.
  return createBrowserClient(supabaseUrl()!, supabaseAnonKey()!);
};
