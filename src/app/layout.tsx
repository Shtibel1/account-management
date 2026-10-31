import type { Metadata } from 'next';
import './globals.css';
import { ToastProvider } from '@/components/ui/Toast';
import { ConfirmProvider } from '@/components/ui/ConfirmDialog';

// The app's brand (see src/components/ui/Logo.tsx). Each route sets its own title through a
// small layout.tsx (e.g. src/app/(dashboard)/clients/layout.tsx); the marketing pages keep theirs.
const APP_BRAND = 'חשבוניות Pro';

export const metadata: Metadata = {
  title: { default: APP_BRAND, template: `%s | ${APP_BRAND}` },
  description: 'סריקת חשבוניות ספקים, בדיקה ואישור וייצוא להנהלת חשבונות — למשרדי הנהלת חשבונות.',
  openGraph: {
    title: APP_BRAND,
    description: 'סריקת חשבוניות ספקים, בדיקה ואישור וייצוא להנהלת חשבונות',
    locale: 'he_IL',
    type: 'website',
  },
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
