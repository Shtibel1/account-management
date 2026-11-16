import Link from 'next/link';
import { LogIn } from 'lucide-react';
import { Logo } from '@/components/ui/Logo';
import { ACCOUNTANTS_PATH, PRODUCT, SCAN_SITE } from '@/lib/seo';

/**
 * Shell of the public product page for accounting offices (חשבוניות Pro). Separate from the
 * scanning service's (marketing) layout on purpose: its own brand, its own header (login / open an
 * office) and a small link back to the scanning service.
 */
export default function AccountantsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col bg-slate-50">
      <header className="sticky top-0 z-50 bg-white/95 backdrop-blur-sm border-b border-slate-200">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-2 flex items-center justify-between gap-3">
          <Link href={ACCOUNTANTS_PATH} aria-label={`${PRODUCT} - עמוד המוצר`} className="inline-flex min-h-[44px] items-center">
            <Logo size="md" />
          </Link>
          <nav aria-label="ניווט ראשי" className="flex items-center gap-1">
            <a href="#features" className="hidden md:inline-flex items-center px-4 min-h-[44px] rounded-lg text-sm font-medium text-slate-600 hover:text-slate-900 hover:bg-slate-100">
              יכולות
            </a>
            <a href="#faq" className="hidden md:inline-flex items-center px-4 min-h-[44px] rounded-lg text-sm font-medium text-slate-600 hover:text-slate-900 hover:bg-slate-100">
              שאלות נפוצות
            </a>
            <Link href="/login" className="inline-flex items-center gap-1.5 px-3 sm:px-4 min-h-[44px] rounded-lg text-sm font-semibold text-blue-700 hover:bg-blue-50">
              <LogIn className="w-4 h-4" />
              כניסה
            </Link>
            <Link href="/signup" className="inline-flex items-center px-3 sm:px-4 min-h-[44px] rounded-lg text-sm font-semibold bg-blue-600 hover:bg-blue-700 text-white shadow-sm">
              פתיחת משרד
            </Link>
          </nav>
        </div>
      </header>

      <main className="flex-1">{children}</main>

      <footer className="bg-slate-900 text-slate-400 py-8 px-4">
        <div className="max-w-6xl mx-auto text-center space-y-4">
          <div className="flex justify-center">
            <Logo size="sm" variant="dark" />
          </div>
          <nav aria-label="קישורים בתחתית העמוד" className="flex flex-wrap justify-center gap-x-2 text-sm">
            <Link href="/login" className="px-3 py-3 hover:text-white transition-colors">כניסה</Link>
            <Link href="/signup" className="px-3 py-3 hover:text-white transition-colors">פתיחת משרד</Link>
            <a href="#faq" className="px-3 py-3 hover:text-white transition-colors">שאלות נפוצות</a>
          </nav>
          <p className="text-sm">
            מחפשים סריקה של תמונות, אלבומים או מסמכים משפחתיים?{' '}
            <Link href="/" className="inline-block py-3 text-slate-300 hover:text-white underline underline-offset-4">
              לשירות {SCAN_SITE}
            </Link>
          </p>
          <p className="text-xs text-slate-400">
            © {new Date().getFullYear()} {PRODUCT} · <bdi dir="ltr">contact@nadav-shtibel.com</bdi>
          </p>
        </div>
      </footer>
    </div>
  );
}
