'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Loader2, LogIn, Mail } from 'lucide-react';
import clsx from 'clsx';
import { createClient } from '@/utils/supabase/client';
import { isSupabaseConfigured } from '@/lib/supabaseConfig';
import { safeNextPath } from '@/lib/routeAccess';
import { AuthShell, FormMessage, authErrorHe } from '@/components/Auth/AuthShell';

type Mode = 'password' | 'magic';

function LoginForm() {
  const params = useSearchParams();
  const next = safeNextPath(params.get('next'));
  const callbackError = params.get('error');

  const [mode, setMode] = useState<Mode>('password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(callbackError ? authErrorHe(callbackError) : null);
  const [magicSent, setMagicSent] = useState(false);

  if (!isSupabaseConfigured()) {
    return (
      <AuthShell title="התחברות" subtitle="מצב סימולציה מקומי">
        <FormMessage kind="info">
          Supabase אינו מוגדר, ולכן המערכת רצה ללא התחברות (פיתוח מקומי בלבד).
        </FormMessage>
        <Link href={next} className="block text-center bg-blue-600 hover:bg-blue-700 text-white rounded-xl py-2.5 text-sm font-semibold">
          כניסה למערכת
        </Link>
      </AuthShell>
    );
  }

  const handlePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error: signInError } = await createClient().auth.signInWithPassword({ email: email.trim(), password });
    if (signInError) {
      setError(authErrorHe(signInError.message));
      setBusy(false);
      return;
    }
    // Full navigation so the proxy sees the new session cookies.
    window.location.assign(next);
  };

  const handleMagic = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error: otpError } = await createClient().auth.signInWithOtp({
      email: email.trim(),
      options: {
        // Magic links only for existing accounts; new offices sign up at /signup.
        shouldCreateUser: false,
        emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`,
      },
    });
    setBusy(false);
    if (otpError) {
      setError(authErrorHe(otpError.message));
      return;
    }
    setMagicSent(true);
  };

  return (
    <AuthShell
      title="התחברות למערכת"
      subtitle="ניהול חשבוניות ללקוחות המשרד"
      footer={
        <>
          עדיין אין לכם חשבון?{' '}
          <Link href={`/signup${next !== '/clients' ? `?next=${encodeURIComponent(next)}` : ''}`} className="font-semibold text-blue-600 hover:text-blue-700">
            פתיחת משרד חדש
          </Link>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-1 p-1 bg-slate-100 rounded-xl text-sm font-medium" role="tablist">
        {([
          ['password', 'סיסמה'],
          ['magic', 'קישור באימייל'],
        ] as [Mode, string][]).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={mode === value}
            onClick={() => { setMode(value); setError(null); setMagicSent(false); }}
            className={clsx('py-2 rounded-lg transition-colors', mode === value ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700')}
          >
            {label}
          </button>
        ))}
      </div>

      {error && <FormMessage kind="error">{error}</FormMessage>}

      {mode === 'magic' && magicSent ? (
        <FormMessage kind="success">
          שלחנו קישור התחברות אל <span dir="ltr" className="font-semibold">{email.trim()}</span>. פתחו אותו מאותו מכשיר כדי להיכנס.
        </FormMessage>
      ) : (
        <form onSubmit={mode === 'password' ? handlePassword : handleMagic} className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="login-email" className="block text-sm font-medium text-slate-700">אימייל</label>
            <input
              id="login-email"
              type="email"
              required
              autoComplete="email"
              dir="ltr"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="input-base text-left"
              placeholder="name@office.co.il"
            />
          </div>

          {mode === 'password' && (
            <div className="space-y-1.5">
              <label htmlFor="login-password" className="block text-sm font-medium text-slate-700">סיסמה</label>
              <input
                id="login-password"
                type="password"
                required
                autoComplete="current-password"
                dir="ltr"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="input-base text-left"
              />
            </div>
          )}

          <button
            type="submit"
            disabled={busy}
            className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white rounded-xl py-2.5 text-sm font-semibold transition-colors shadow-sm"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : mode === 'password' ? <LogIn className="h-4 w-4" /> : <Mail className="h-4 w-4" />}
            {mode === 'password' ? 'התחברות' : 'שליחת קישור התחברות'}
          </button>
        </form>
      )}
    </AuthShell>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
