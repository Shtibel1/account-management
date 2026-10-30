/**
 * Public origin of the app for redirects and links in emails. Pure (no Next / Node imports), so it
 * works in the proxy, route handlers and scratch checks.
 *
 * Behind Amplify Hosting (SSR compute) `request.url` is the internal `https://localhost:3000`, so
 * `new URL(path, request.url)` produces a Location / email link that points at localhost. The
 * trusted origin is, in order:
 *   1. NEXT_PUBLIC_SITE_URL (set in Amplify, written to .env.production by amplify.yml);
 *   2. the X-Forwarded-Host of the request, ONLY when that host is on the allow-list
 *      (SITE_ALLOWED_HOSTS, comma separated, plus `<AWS_BRANCH>.<AWS_APP_ID>.amplifyapp.com`
 *      when Amplify provides those variables) - never an arbitrary header value;
 *   3. the request's own origin, unless it is a loopback host in production.
 * Without a trusted origin, redirects stay relative (`Location: /path`, valid per RFC 9110) and
 * email links can't be built (the caller answers with a Hebrew error instead of a localhost link).
 */

export interface SiteOriginInput {
  /** NEXT_PUBLIC_SITE_URL */
  configured?: string | null;
  /** Extra allowed hosts (SITE_ALLOWED_HOSTS) */
  allowedHosts?: string | null;
  /** Amplify app / branch (AWS_APP_ID / AWS_BRANCH) */
  amplifyAppId?: string | null;
  amplifyBranch?: string | null;
  /** Request headers */
  forwardedHost?: string | null;
  forwardedProto?: string | null;
  /** The request URL as the server sees it */
  requestUrl?: string | null;
  production?: boolean;
}

const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)(:\d+)?$/i;
const HOST_RE = /^[a-z0-9.-]+(:\d{1,5})?$/i;

function originOf(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function allowedHostList(input: Pick<SiteOriginInput, 'allowedHosts' | 'amplifyAppId' | 'amplifyBranch' | 'configured'>): string[] {
  const hosts = (input.allowedHosts ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  if (input.amplifyAppId && input.amplifyBranch) {
    hosts.push(`${input.amplifyBranch}.${input.amplifyAppId}.amplifyapp.com`.toLowerCase());
  }
  const configured = originOf(input.configured);
  if (configured) hosts.push(new URL(configured).host.toLowerCase());
  return [...new Set(hosts)];
}

/** The trusted public origin, or null when none can be established. */
export function resolveSiteOrigin(input: SiteOriginInput): string | null {
  const configured = originOf(input.configured);
  if (configured) return configured;

  const forwarded = (input.forwardedHost ?? '').split(',')[0].trim().toLowerCase();
  if (forwarded && HOST_RE.test(forwarded) && allowedHostList(input).includes(forwarded)) {
    const proto = (input.forwardedProto ?? '').split(',')[0].trim().toLowerCase();
    return `${proto === 'http' ? 'http' : 'https'}://${forwarded}`;
  }

  const own = originOf(input.requestUrl);
  if (own) {
    const host = new URL(own).host;
    if (!(input.production && LOOPBACK.test(host))) return own;
  }
  return null;
}

interface HeaderReader {
  get(name: string): string | null;
}

/** resolveSiteOrigin with the process env + the request's headers. */
export function siteOriginFor(request: { url: string; headers: HeaderReader }): string | null {
  return resolveSiteOrigin({
    configured: process.env.NEXT_PUBLIC_SITE_URL,
    allowedHosts: process.env.SITE_ALLOWED_HOSTS,
    amplifyAppId: process.env.AWS_APP_ID,
    amplifyBranch: process.env.AWS_BRANCH,
    forwardedHost: request.headers.get('x-forwarded-host'),
    forwardedProto: request.headers.get('x-forwarded-proto'),
    requestUrl: request.url,
    production: process.env.NODE_ENV === 'production',
  });
}

/**
 * Location value for a same-site redirect to `path` (an already sanitized absolute path such as the
 * result of safeNextPath): absolute on the trusted origin, otherwise relative.
 */
export function redirectLocation(path: string, origin: string | null): string {
  const safePath = path.startsWith('/') && !path.startsWith('//') && !path.startsWith('/\\') ? path : '/';
  return origin ? `${origin}${safePath}` : safePath;
}

