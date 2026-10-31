import type { Metadata } from 'next';

/**
 * SEO helpers shared by the page metadata, app/sitemap.ts, app/robots.ts and the X-Robots-Tag
 * header rules. Pure (no Next runtime imports) so it can be unit-checked.
 *
 * The app serves two audiences on one domain, kept apart on purpose:
 *   - SCAN_SITE: the public scanning service "סריקה בעברית" ("/", "/order", "/privacy");
 *   - PRODUCT:   the accounting-office SaaS "חשבוניות Pro" (landing page /accountants, /login,
 *                /signup and the signed-in app).
 * Every public page builds its metadata with pageMetadata() and names its own site, so titles,
 * descriptions and Open Graph tags never leak from one audience to the other.
 */

export const SCAN_SITE = 'סריקה בעברית';
export const PRODUCT = 'חשבוניות Pro';

/** The accountants landing page (ASCII slug: readable when shared, no percent-encoded Hebrew). */
export const ACCOUNTANTS_PATH = '/accountants';

/** Indexable public pages, in sitemap order. */
export const PUBLIC_INDEXABLE_PAGES: { path: string; changeFrequency: 'weekly' | 'monthly' | 'yearly'; priority: number }[] = [
  { path: '/', changeFrequency: 'monthly', priority: 1 },
  { path: ACCOUNTANTS_PATH, changeFrequency: 'monthly', priority: 0.9 },
  { path: '/order', changeFrequency: 'monthly', priority: 0.7 },
  { path: '/privacy', changeFrequency: 'yearly', priority: 0.3 },
];

/**
 * The signed-in app and the API: disallowed in robots.txt and sent with `X-Robots-Tag: noindex`.
 * (/login and /signup are NOT here: they carry a noindex meta tag, which a crawler only sees when
 * robots.txt lets it fetch the page.)
 */
export const APP_ROUTE_PREFIXES = [
  '/clients',
  '/upload',
  '/review',
  '/mappings',
  '/bank',
  '/integrations',
  '/integration-logs',
  '/settings',
  '/dashboard',
  '/auth',
  '/api',
] as const;

function originOf(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Absolute base URL for canonical / Open Graph / sitemap links: NEXT_PUBLIC_SITE_URL, else the Amplify
 * default domain of the branch (<branch>.<appId>.amplifyapp.com), else the local dev server.
 */
export function resolveSiteBaseUrl(env: {
  siteUrl?: string | null;
  amplifyAppId?: string | null;
  amplifyBranch?: string | null;
}): string {
  const configured = originOf(env.siteUrl);
  if (configured) return configured;
  const appId = (env.amplifyAppId ?? '').trim().toLowerCase();
  const branch = (env.amplifyBranch ?? '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
  if (branch && /^[a-z0-9]+$/.test(appId)) return `https://${branch}.${appId}.amplifyapp.com`;
  return 'http://localhost:3001';
}

export function siteBaseUrl(): string {
  return resolveSiteBaseUrl({
    siteUrl: process.env.NEXT_PUBLIC_SITE_URL,
    amplifyAppId: process.env.SITE_AMPLIFY_APP_ID || process.env.AWS_APP_ID,
    amplifyBranch: process.env.SITE_AMPLIFY_BRANCH || process.env.AWS_BRANCH,
  });
}

interface PageMetaInput {
  /** Full <title> (no template is applied) */
  title: string;
  description: string;
  /** Canonical path, e.g. "/accountants" (resolved against metadataBase) */
  path: string;
  /** Which audience's site this page belongs to (og:site_name) */
  siteName: typeof SCAN_SITE | typeof PRODUCT;
  /** true = noindex, follow (thin pages such as login) */
  noindex?: boolean;
}

/** Title, description, canonical, Open Graph, Twitter and robots of one public page. */
export function pageMetadata({ title, description, path, siteName, noindex = false }: PageMetaInput): Metadata {
  return {
    title: { absolute: title },
    description,
    alternates: { canonical: path },
    openGraph: { title, description, url: path, siteName, locale: 'he_IL', type: 'website' },
    twitter: { card: 'summary', title, description },
    robots: noindex ? { index: false, follow: true } : { index: true, follow: true },
  };
}

/** Serializes JSON-LD for a <script type="application/ld+json"> (escapes "<" so it can't close the tag). */
export function jsonLd(data: unknown): string {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}
