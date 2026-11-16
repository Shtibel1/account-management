'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { Logo } from '@/components/ui/Logo';
import {
  Upload, ClipboardCheck, Users, BookOpen, LayoutDashboard, Landmark, LogOut, Building2, FlaskConical, Plug, ScrollText, Menu, X, UserCog,
} from 'lucide-react';
import versionData from '@/shared/version.json';
import { SessionProvider, useSession } from '@/components/Auth/SessionContext';
import { isSupabaseConfigured } from '@/lib/supabaseConfig';
import { useEscapeKey } from '@/components/ui/useEscapeKey';

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
  { href: '/settings/members', label: 'משתמשי המשרד', icon: UserCog },
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
  // Below md the sidebar is an off-canvas drawer opened from the top bar
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Navigating closes the drawer
  useEffect(() => { setDrawerOpen(false); }, [pathname]);
  useEscapeKey(() => setDrawerOpen(false), drawerOpen);

  const pageTitle = [...navItems, ...ownerNavItems].find(i => pathname.startsWith(i.href))?.label ?? 'מערכת חשבוניות';

  return (
    <div className="flex flex-row min-h-screen bg-slate-100">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:right-2 focus:z-50 focus:bg-white focus:text-blue-700 focus:px-4 focus:py-2 focus:rounded-lg focus:shadow-lg"
      >
        דילוג לתוכן הראשי
      </a>
      {/* Drawer backdrop (mobile only) */}
      {drawerOpen && (
        <div
          className="fixed inset-0 z-30 bg-slate-900/50 md:hidden"
          onClick={() => setDrawerOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Sidebar — ימין (RTL). Static from md; an off-canvas drawer below it. */}
      <aside
        id="dashboard-sidebar"
        className={clsx(
          'w-64 shrink-0 bg-slate-900 flex flex-col h-screen',
          'fixed inset-y-0 right-0 z-40 duration-200 md:sticky md:top-0 md:right-auto md:translate-x-0',
          // Closed drawer is also hidden from keyboard / screen readers on phones (it is only moved off-screen otherwise)
          drawerOpen ? 'translate-x-0 shadow-2xl visible' : 'translate-x-full invisible md:visible',
          'transition-[transform,visibility]'
        )}
        aria-label="ניווט ראשי"
      >
        {/* Logo */}
        <div className="px-5 py-6 border-b border-white/10 flex items-center justify-between gap-2">
          <Logo size="md" variant="dark" />
          <button
            type="button"
            onClick={() => setDrawerOpen(false)}
            className="md:hidden -ml-2 h-11 w-11 inline-flex items-center justify-center text-slate-400 hover:text-white hover:bg-white/10 rounded-lg"
            aria-label="סגור תפריט"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
          {items.map(({ href, label, icon: Icon }) => {
            const active = pathname === href || pathname.startsWith(href + '/');
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? 'page' : undefined}
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
        <header className="bg-white border-b border-slate-200 px-4 sm:px-6 md:px-8 py-3 md:py-4 flex items-center justify-between gap-3 sticky top-0 z-10">
          <div className="flex items-center gap-2 min-w-0">
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              className="md:hidden -mr-2 h-11 w-11 inline-flex items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100"
              aria-label="פתח תפריט"
              aria-controls="dashboard-sidebar"
              aria-expanded={drawerOpen}
            >
              <Menu className="h-5 w-5" />
            </button>
            <h1 className="text-lg font-semibold text-slate-800 truncate">{pageTitle}</h1>
          </div>
          <div className="hidden sm:flex items-center gap-2 shrink-0">
            {/* Israel time on server and browser alike; the server (UTC) and browser can still straddle midnight */}
            <span className="text-xs text-slate-400 bg-slate-100 px-3 py-1 rounded-full" suppressHydrationWarning>
              {new Date().toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Asia/Jerusalem' })}
            </span>
          </div>
        </header>

        {!isSupabaseConfigured() && (
          <div className="bg-amber-50 border-b border-amber-200 px-4 sm:px-6 md:px-8 py-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-amber-800">
            <span className="flex h-2 w-2 rounded-full bg-amber-500 animate-pulse shrink-0" />
            <span className="font-semibold">סימולציה מקומית (Local Mock Mode):</span>
            <span>חיבור ה-Supabase אינו מוגדר. הנתונים נשמרים מקומית. כדי להתחבר לבסיס נתונים חי, הגדר קובץ .env.local</span>
          </div>
        )}

        <div id="main-content" tabIndex={-1} className="flex-1 min-w-0 p-4 sm:p-6 md:p-8 focus:outline-none">
          {children}
        </div>

      </main>
    </div>
  );
}
