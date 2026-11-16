/**
 * Supabase configuration / mock-mode detection. Safe to import anywhere (browser, proxy, server):
 * only reads NEXT_PUBLIC_* values and NODE_ENV.
 *
 * Mock mode = Supabase env missing -> local JSON mock DB and NO authentication (local development
 * only). In production mock mode is never allowed: requests fail closed (see src/proxy.ts and
 * requireUser() in src/lib/auth.ts).
 */

const PLACEHOLDER_URL = 'https://placeholder-url.supabase.co';

export function supabaseUrl(): string | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  return url && url !== PLACEHOLDER_URL ? url : null;
}

export function supabaseAnonKey(): string | null {
  const key = (process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)?.trim();
  return key && key !== 'placeholder-key' ? key : null;
}

/** True when the app talks to a real Supabase project (URL + anon key present). */
export function isSupabaseConfigured(): boolean {
  return supabaseUrl() !== null && supabaseAnonKey() !== null;
}

export function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

/** Local mock DB without auth: only outside production. */
export function isMockMode(): boolean {
  return !isSupabaseConfigured() && !isProduction();
}

/** Production build without Supabase env: everything that needs data/auth must refuse to run. */
export function isMisconfiguredProduction(): boolean {
  return !isSupabaseConfigured() && isProduction();
}

export const MISCONFIGURED_MESSAGE =
  'Supabase is not configured (NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY). Refusing to run without authentication in production.';
