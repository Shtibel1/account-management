import type { Metadata } from 'next';
import { pageMetadata, PRODUCT } from '@/lib/seo';

// Thin form page: noindex (links still followed). The indexable entry for the product is /accountants.
export const metadata: Metadata = pageMetadata({
  title: 'כניסה | חשבוניות Pro',
  description: 'כניסה למערכת חשבוניות Pro לניהול חשבוניות הספקים של לקוחות המשרד.',
  path: '/login',
  siteName: PRODUCT,
  noindex: true,
});

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
