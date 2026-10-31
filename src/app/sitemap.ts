import type { MetadataRoute } from 'next';
import { PUBLIC_INDEXABLE_PAGES, siteBaseUrl } from '@/lib/seo';

/** /sitemap.xml: the indexable public pages only (never /login, /signup or the app). */
export default function sitemap(): MetadataRoute.Sitemap {
  const base = siteBaseUrl();
  return PUBLIC_INDEXABLE_PAGES.map(({ path, changeFrequency, priority }) => ({
    url: `${base}${path}`,
    changeFrequency,
    priority,
  }));
}
