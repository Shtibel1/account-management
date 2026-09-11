'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { Menu, X, Camera, FileText, Home, Shield } from 'lucide-react';
import clsx from 'clsx';

const navItems = [
  { href: '/', label: 'בית', icon: Home },
  { href: '/order', label: 'הזמנה', icon: FileText },
  { href: '/privacy', label: 'פרטיות', icon: Shield },
];

function MarketingLogo() {
  return (
    <Link href="/" className="flex items-center gap-2.5 select-none group">
      <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-600 to-blue-700 flex items-center justify-center shadow-md group-hover:shadow-lg transition-shadow">
        <Camera className="w-5 h-5 text-white" />
      </div>
      <div className="leading-none">
        <p className="font-bold text-slate-900 text-base tracking-tight">
          סריקה בעברית
        </p>
        <p className="text-xs text-blue-600 font-medium">
          תמונות ומסמכים
        </p>
      </div>
    </Link>
  );
}

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="min-h-screen flex flex-col bg-stone-50">
      {/* Header */}
      <header className="sticky top-0 z-50 bg-white/95 backdrop-blur-sm border-b border-stone-200">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between">
          <MarketingLogo />

          {/* Desktop nav */}
          <nav className="hidden sm:flex items-center gap-1">
            {navItems.map(({ href, label }) => {
              const active = pathname === href;
              return (
                <Link
                  key={href}
                  href={href}
                  className={clsx(
                    'px-4 py-2 rounded-lg text-sm font-medium transition-colors',
                    active
                      ? 'bg-blue-50 text-blue-700'
                      : 'text-stone-600 hover:text-stone-900 hover:bg-stone-100'
                  )}
                >
                  {label}
                </Link>
              );
            })}
          </nav>

          {/* Mobile hamburger */}
          <button
            onClick={() => setMenuOpen(!menuOpen)}
            className="sm:hidden p-2 rounded-lg text-stone-600 hover:bg-stone-100 transition-colors"
            aria-label={menuOpen ? 'סגור תפריט' : 'פתח תפריט'}
          >
            {menuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </div>

        {/* Mobile menu */}
        {menuOpen && (
          <nav className="sm:hidden border-t border-stone-100 bg-white px-4 py-3 space-y-1">
            {navItems.map(({ href, label, icon: Icon }) => {
              const active = pathname === href;
              return (
                <Link
                  key={href}
                  href={href}
                  onClick={() => setMenuOpen(false)}
                  className={clsx(
                    'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors',
                    active
                      ? 'bg-blue-50 text-blue-700'
                      : 'text-stone-600 hover:bg-stone-100'
                  )}
                >
                  <Icon className="w-4 h-4" />
                  {label}
                </Link>
              );
            })}
          </nav>
        )}
      </header>

      {/* Main content */}
      <main className="flex-1">
        {children}
      </main>

      {/* Footer */}
      <footer className="bg-stone-900 text-stone-400 py-8 px-4">
        <div className="max-w-5xl mx-auto text-center space-y-4">
          <div className="flex items-center justify-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center">
              <Camera className="w-4 h-4 text-white" />
            </div>
            <span className="font-semibold text-white">סריקה בעברית</span>
          </div>
          <div className="flex justify-center gap-6 text-sm">
            <Link href="/" className="hover:text-white transition-colors">בית</Link>
            <Link href="/order" className="hover:text-white transition-colors">הזמנה</Link>
            <Link href="/privacy" className="hover:text-white transition-colors">פרטיות</Link>
          </div>
          <p className="text-xs text-stone-500">
            © {new Date().getFullYear()} סריקה בעברית · contact@nadav-shtibel.com
          </p>
        </div>
      </footer>
    </div>
  );
}
