import type { MetadataRoute } from 'next';
import { APP_ROUTE_PREFIXES, siteBaseUrl } from '@/lib/seo';
import { siteNoindex } from '@/lib/securityHeaders';

/** /robots.txt: public pages are crawlable, the signed-in app and the API are not. */
export default function robots(): MetadataRoute.Robots {
  const base = siteBaseUrl();
  if (siteNoindex()) return { rules: [{ userAgent: '*', disallow: '/' }] };
  return {
    rules: [{ userAgent: '*', allow: '/', disallow: [...APP_ROUTE_PREFIXES] }],
    sitemap: `${base}/sitemap.xml`,
  };
}
