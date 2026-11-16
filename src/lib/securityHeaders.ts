/**
 * Response headers applied by next.config.ts `headers()` (QA #33). Pure data so it can be checked.
 *
 *   - every response: nosniff, HSTS, frame / referrer policy;
 *   - every /api/* response: `Cache-Control: private, no-store` - API answers carry per-office data
 *     and must never be stored by CloudFront / shared caches / the browser cache;
 *   - /auth/* (callback, complete): no-store too (they set the session cookies);
 *   - the signed-in app and the API (APP_ROUTE_PREFIXES in src/lib/seo.ts): `X-Robots-Tag: noindex`;
 *   - with SITE_NOINDEX=1 (non-production branches such as qa): every response is noindex.
 * Pages keep Next's own caching (static marketing pages stay cacheable).
 */
import { APP_ROUTE_PREFIXES } from './seo';

export interface HeaderRule {
  source: string;
  headers: { key: string; value: string }[];
}

export const BASE_SECURITY_HEADERS: { key: string; value: string }[] = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
  { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
];

export const NO_STORE_HEADERS: { key: string; value: string }[] = [
  { key: 'Cache-Control', value: 'private, no-store, max-age=0' },
  { key: 'Pragma', value: 'no-cache' },
];

export const NOINDEX_HEADERS: { key: string; value: string }[] = [
  { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
];

/** SITE_NOINDEX=1 keeps a whole deployment (e.g. the qa branch) out of search engines. */
export function siteNoindex(env: string | undefined = process.env.SITE_NOINDEX): boolean {
  return env === '1' || env === 'true';
}

export const SECURITY_HEADER_RULES: HeaderRule[] = [
  { source: '/:path*', headers: siteNoindex() ? [...BASE_SECURITY_HEADERS, ...NOINDEX_HEADERS] : BASE_SECURITY_HEADERS },
  { source: '/api/:path*', headers: NO_STORE_HEADERS },
  { source: '/auth/:path*', headers: NO_STORE_HEADERS },
  ...APP_ROUTE_PREFIXES.map((prefix) => ({ source: `${prefix}/:path*`, headers: NOINDEX_HEADERS })),
];
