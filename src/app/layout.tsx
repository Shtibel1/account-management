import type { Metadata } from 'next';
import './globals.css';
import { ToastProvider } from '@/components/ui/Toast';
import { ConfirmProvider } from '@/components/ui/ConfirmDialog';
import { PRODUCT, siteBaseUrl } from '@/lib/seo';

// Defaults for the signed-in app (brand "חשבוניות Pro", see src/components/ui/Logo.tsx). Each app
// route sets its own title through a small layout.tsx (e.g. src/app/(dashboard)/clients/layout.tsx).
// Public pages (marketing site, /accountants, /login, /signup) replace all of this with
// pageMetadata() from src/lib/seo.ts, including robots.
export const metadata: Metadata = {
  // Canonical / Open Graph URLs resolve against the public origin (NEXT_PUBLIC_SITE_URL).
  metadataBase: new URL(siteBaseUrl()),
  applicationName: PRODUCT,
  title: { default: PRODUCT, template: `%s | ${PRODUCT}` },
  description: 'סריקת חשבוניות ספקים, בדיקה ואישור וייצוא להנהלת חשבונות — למשרדי הנהלת חשבונות.',
  openGraph: {
    title: PRODUCT,
    description: 'סריקת חשבוניות ספקים, בדיקה ואישור וייצוא להנהלת חשבונות',
    siteName: PRODUCT,
    locale: 'he_IL',
    type: 'website',
  },
  // Every page is noindex unless it opts in (public pages do through pageMetadata()); the app
  // routes also get an X-Robots-Tag header (src/lib/securityHeaders.ts).
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="he" dir="rtl">
      <body>
        <ToastProvider>
          <ConfirmProvider>{children}</ConfirmProvider>
        </ToastProvider>
      </body>
    </html>
  );
}
