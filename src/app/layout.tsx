import type { Metadata } from 'next';
import './globals.css';
import { ToastProvider } from '@/components/ui/Toast';

export const metadata: Metadata = {
  title: 'מערכת עיבוד חשבוניות',
  description: 'עיבוד ואישור חשבוניות מס לייצוא למערכת הנהלת חשבונות',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="he" dir="rtl">
      <body>
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
