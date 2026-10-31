import type { Metadata } from 'next';
import { pageMetadata, SCAN_SITE } from '@/lib/seo';

export const metadata: Metadata = pageMetadata({
  title: 'הזמנת סריקה והצעת מחיר | סריקה בעברית',
  description: 'השאירו פרטים על התמונות, האלבומים או המסמכים שתרצו לסרוק ונחזור אליכם עם הצעת מחיר לסריקה בעברית.',
  path: '/order',
  siteName: SCAN_SITE,
});

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
