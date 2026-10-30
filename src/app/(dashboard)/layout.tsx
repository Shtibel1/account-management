'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import clsx from 'clsx';
import { Logo } from '@/components/ui/Logo';
import {
  Upload, ClipboardCheck, Users, BookOpen, LayoutDashboard, Landmark, LogOut, Building2, FlaskConical, Plug, ScrollText,
} from 'lucide-react';
import versionData from '@/shared/version.json';
import { SessionProvider, useSession } from '@/components/Auth/SessionContext';
import { isSupabaseConfigured } from '@/lib/supabaseConfig';

const navItems = [
  { href: '/clients',  label: 'לקוחות',          icon: Users },
  { href: '/upload',   label: 'העלאת חשבוניות',   icon: Upload },
  { href: '/review',   label: 'בדיקה ואישור',     icon: ClipboardCheck },
  { href: '/mappings', label: 'מיפוי חשבונות',    icon: BookOpen },
  { href: '/bank',     label: 'התאמות בנק',       icon: Landmark },
  { href: '/integrations',     label: 'חיבור להנהלת חשבונות', icon: Plug },
  { href: '/integration-logs', label: 'יומן אינטגרציות',      icon: ScrollText },
];

/** Shown only to office owners (and in local mock mode, where the page explains the env default). */
const ownerNavItems = [
  { href: '/settings/experimental', label: 'תכונות ניסיוניות', icon: FlaskConical },
];

/** Office name, signed-in user and logout at the bottom of the sidebar. */
function SidebarAccount() {
  const { me, loading, currentOrgName, signOut } = useSession();
  const [signingOut, setSigningOut] = useState(false);

  return (
    <div className="px-3 py-3 border-t border-white/10 space-y-2">
      <div className="flex items-center gap-2.5 px-2">
        <div className="h-8 w-8 shrink-0 rounded-lg bg-white/10 flex items-center justify-center">
          <Building2 className="h-4 w-4 text-blue-300" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-white truncate" title={currentOrgName ?? undefined}>
            {loading ? 'טוען...' : currentOrgName || 'ללא משרד'}
          </p>
          {me?.user.email && (
            <p className="text-xs text-slate-400 truncate" dir="ltr" title={me.user.email}>
              {me.user.email}
            </p>
          )}
        </div>
      </div>
      {isSupabaseConfigured() && (
        <button
          type="button"
          onClick={async () => { setSigningOut(true); await signOut(); }}
          disabled={signingOut}
          className="sidebar-item w-full disabled:opacity-60"
        >
          <LogOut className="h-4 w-4 shrink-0" />
          {signingOut ? 'מתנתק...' : 'התנתקות'}
        </button>
      )}
    </div>
  );
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <DashboardShell>{children}</DashboardShell>
    </SessionProvider>
  );
}

function DashboardShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { me } = useSession();
  const isOwner = !!me && (me.mock || me.organizations.some((o) => o.role === 'owner'));
  const items = isOwner ? [...navItems, ...ownerNavItems] : navItems;

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
          {items.map(({ href, label, icon: Icon }) => {
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

        <SidebarAccount />

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
            {[...navItems, ...ownerNavItems].find(i => pathname.startsWith(i.href))?.label ?? 'מערכת חשבוניות'}
          </h1>
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-400 bg-slate-100 px-3 py-1 rounded-full">
              {new Date().toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long' })}
            </span>
          </div>
        </header>

        {!isSupabaseConfigured() && (
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
