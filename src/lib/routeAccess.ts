/**
 * Which paths need a session. Pure (no Next/Supabase imports) so it can be unit-checked and used by
 * src/proxy.ts.
 *
 *   public  - marketing pages, the accountants landing page, auth pages and the ingestion webhooks (which keep
 *             their own secret / Twilio-signature auth).
 *   api     - every other /api/* route: 401 JSON without a session.
 *   page    - every other page (the dashboard): redirect to /login?next=...
 */

export type RouteKind = 'public' | 'api' | 'page';

/** Exact public pages (the (marketing) route group + auth pages). */
const PUBLIC_PAGES = new Set(['/', '/privacy', '/accountants', '/login', '/signup']);

/** Public path prefixes (matched as `prefix` or `prefix/...`). */
const PUBLIC_PREFIXES = ['/auth'];

/** API routes that authenticate on their own (or are intentionally public). */
const PUBLIC_API = new Set(['/api/ingest/email', '/api/ingest/whatsapp', '/api/invoices/worker']);

/** Pages a signed-in user doesn't need (they're sent on to the dashboard). */
export const AUTH_PAGES = new Set(['/login', '/signup']);

export const DEFAULT_AFTER_LOGIN = '/clients';

/**
 * Non-sensitive marker: this browser has been signed in. Lets "/" tell a returning user whose session
 * expired (-> /login) from a new visitor (-> marketing page). Set by src/proxy.ts, removed on sign-out.
 */
export const RETURNING_USER_COOKIE = 'returning_user';
export const RETURNING_USER_MAX_AGE = 60 * 60 * 24 * 365;

/** Where "/" sends this visitor: signed in -> the app, expired session -> login, otherwise stay (null). */
export function homeRedirectPath(signedIn: boolean, returningUser: boolean): string | null {
  if (signedIn) return DEFAULT_AFTER_LOGIN;
  return returningUser ? '/login' : null;
}

function normalize(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith('/')) return pathname.replace(/\/+$/, '') || '/';
  return pathname;
}

function matchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(prefix + '/');
}

export function classifyPath(rawPathname: string): RouteKind {
  const pathname = normalize(rawPathname);
  if (PUBLIC_PAGES.has(pathname)) return 'public';
  if (PUBLIC_PREFIXES.some((p) => matchesPrefix(pathname, p))) return 'public';
  if (pathname === '/api' || pathname.startsWith('/api/')) {
    return PUBLIC_API.has(pathname) ? 'public' : 'api';
  }
  return 'page';
}

/** Webhooks / lead form: no session refresh needed at all. */
export function isPublicApi(rawPathname: string): boolean {
  return PUBLIC_API.has(normalize(rawPathname));
}

/**
 * Sanitizes a post-login redirect target: same-origin absolute paths only (no "//host",
 * "/\\host", schemes or control characters), never back to an auth page.
 */
export function safeNextPath(next: string | null | undefined, fallback: string = DEFAULT_AFTER_LOGIN): string {
  if (!next || typeof next !== 'string') return fallback;
  const value = next.trim();
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return fallback;
  if (/[\u0000-\u001f\\]/.test(value)) return fallback;
  const pathOnly = value.split(/[?#]/)[0];
  if (AUTH_PAGES.has(normalize(pathOnly)) || matchesPrefix(pathOnly, '/auth')) return fallback;
  return value;
}

/** /login?next=<current path + query> */
export function loginRedirectPath(pathname: string, search: string = ''): string {
  const next = safeNextPath(pathname + (search || ''), '');
  return next ? `/login?next=${encodeURIComponent(next)}` : '/login';
}
