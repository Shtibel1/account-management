import type { Metadata } from 'next';
import { pageMetadata, PRODUCT } from '@/lib/seo';

// Thin form page: noindex (links still followed). The indexable entry for the product is /accountants.
export const metadata: Metadata = pageMetadata({
  title: 'פתיחת משרד | חשבוניות Pro',
  description: 'פתיחת משרד חדש בחשבוניות Pro: סריקה וקליטה של חשבוניות ספקים, בדיקה ואישור וייצוא להנהלת חשבונות.',
  path: '/signup',
  siteName: PRODUCT,
  noindex: true,
});

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
