'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import clsx from 'clsx';
import { Logo } from '@/components/ui/Logo';
import {
  Upload, ClipboardCheck, Users, BookOpen, LayoutDashboard,
} from 'lucide-react';
import versionData from '@/shared/version.json';

const navItems = [
  { href: '/clients',  label: 'לקוחות',          icon: Users },
  { href: '/upload',   label: 'העלאת חשבוניות',   icon: Upload },
  { href: '/review',   label: 'בדיקה ואישור',     icon: ClipboardCheck },
  { href: '/mappings', label: 'מיפוי חשבונות',    icon: BookOpen },
];

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="flex flex-row min-h-screen bg-slate-100">
      {/* Sidebar — ימין (RTL) */}
      <aside className="w-64 shrink-0 bg-slate-900 flex flex-col h-screen sticky top-0">
        {/* Logo */}
        <div className="px-5 py-6 border-b border-white/10">
          <Logo size="md" variant="dark" />
        </div>

        {/* Nav */}
        <nav className="flex-1 px-3 py-4 space-y-1">
          {navItems.map(({ href, label, icon: Icon }) => {
            const active = pathname === href || pathname.startsWith(href + '/');
            return (
              <Link
                key={href}
                href={href}
                className={clsx('sidebar-item', active && 'sidebar-item-active')}
              >
                <Icon className="h-4 w-4 shrink-0" />
                {label}
              </Link>
            );
          })}
        </nav>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-white/10">
          <p className="text-xs text-slate-500">גרסה {versionData.version} · {new Date().getFullYear()}</p>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 flex flex-col min-w-0">
        {/* Top bar */}
        <header className="bg-white border-b border-slate-200 px-8 py-4 flex items-center justify-between sticky top-0 z-10">
          <h1 className="text-lg font-semibold text-slate-800">
            {navItems.find(i => pathname.startsWith(i.href))?.label ?? 'מערכת חשבוניות'}
          </h1>
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-400 bg-slate-100 px-3 py-1 rounded-full">
              {new Date().toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long' })}
            </span>
          </div>
        </header>

        {!(
          process.env.NEXT_PUBLIC_SUPABASE_URL &&
          process.env.NEXT_PUBLIC_SUPABASE_URL !== 'https://placeholder-url.supabase.co'
        ) && (
          <div className="bg-amber-50 border-b border-amber-200 px-8 py-2.5 flex items-center gap-3 text-sm text-amber-800">
            <span className="flex h-2 w-2 rounded-full bg-amber-500 animate-pulse shrink-0" />
            <span className="font-semibold">סימולציה מקומית (Local Mock Mode):</span>
            <span>חיבור ה-Supabase אינו מוגדר. הנתונים נשמרים מקומית. כדי להתחבר לבסיס נתונים חי, הגדר קובץ .env.local</span>
          </div>
        )}

        <div className="flex-1 p-8">
          {children}
        </div>

      </main>
    </div>
  );
}
