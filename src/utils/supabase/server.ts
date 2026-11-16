import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { mockClient } from './mockClient';
import { isSupabaseConfigured, MISCONFIGURED_MESSAGE, isProduction, supabaseAnonKey, supabaseUrl } from '@/lib/supabaseConfig';

/**
 * Cookie-session Supabase client for server components / route handlers. Uses the anon key + the
 * signed-in user's session, so RLS applies (role `authenticated`). Mock DB in local mock mode.
 */
export const createClient = async () => {
  if (!isSupabaseConfigured()) {
    if (isProduction()) throw new Error(MISCONFIGURED_MESSAGE);
    return mockClient as unknown as ReturnType<typeof createServerClient>;
  }
  const cookieStore = await cookies();
  return createServerClient(supabaseUrl()!, supabaseAnonKey()!, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (cookiesToSet: { name: string; value: string; options?: object }[]) => {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options as Parameters<typeof cookieStore.set>[2])
          );
        } catch (err) {
          // Called from a server component (read-only cookies). The proxy refreshes the session
          // cookies on every request, so this is safe to ignore.
          if (process.env.NODE_ENV !== 'production') {
            console.warn('[supabase/server] Could not set auth cookies here (read-only context):', err instanceof Error ? err.message : err);
          }
        }
      },
    },
  });
};
