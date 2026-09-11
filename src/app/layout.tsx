import type { Metadata } from 'next';
import './globals.css';
import { ToastProvider } from '@/components/ui/Toast';

export const metadata: Metadata = {
  title: 'סריקה בעברית | סריקת תמונות ומסמכים בעברית',
  description: 'סריקת תמונות ואלבומים, מסמכים וחשבוניות בעברית. זיהוי טקסט עברי (OCR) — קבצים דיגיטליים שאפשר לחפש.',
  keywords: ['סריקה', 'עברית', 'OCR', 'תמונות', 'מסמכים', 'חשבוניות', 'אלבומים', 'דיגיטציה'],
  openGraph: {
    title: 'סריקה בעברית',
    description: 'סריקת תמונות ומסמכים בעברית עם זיהוי טקסט',
    locale: 'he_IL',
    type: 'website',
  },
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
