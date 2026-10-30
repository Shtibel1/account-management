'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Loader2, UserPlus } from 'lucide-react';
import { createClient } from '@/utils/supabase/client';
import { isSupabaseConfigured } from '@/lib/supabaseConfig';
import { safeNextPath } from '@/lib/routeAccess';
import { AuthShell, FormMessage, authErrorHe } from '@/components/Auth/AuthShell';

const MIN_PASSWORD = 8;

function SignupForm() {
  const params = useSearchParams();
  const next = safeNextPath(params.get('next'));

  const [orgName, setOrgName] = useState('');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmSent, setConfirmSent] = useState(false);

  if (!isSupabaseConfigured()) {
    return (
      <AuthShell title="פתיחת משרד חדש" subtitle="מצב סימולציה מקומי">
        <FormMessage kind="info">Supabase אינו מוגדר, ולכן אין הרשמה במצב זה (פיתוח מקומי בלבד).</FormMessage>
        <Link href="/clients" className="block text-center bg-blue-600 hover:bg-blue-700 text-white rounded-xl py-2.5 text-sm font-semibold">
          כניסה למערכת
        </Link>
      </AuthShell>
    );
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < MIN_PASSWORD) {
      setError(`הסיסמה חייבת להכיל לפחות ${MIN_PASSWORD} תווים`);
      return;
    }
    setBusy(true);
    setError(null);
    // The database trigger creates the organization (named org_name) with this user as owner
    // once the email is confirmed - see supabase/migrations/20261030140000_auth_tenancy.sql.
    const { data, error: signUpError } = await createClient().auth.signUp({
      email: email.trim(),
      password,
      options: {
        data: { org_name: orgName.trim() || undefined, full_name: fullName.trim() || undefined },
        emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`,
      },
    });
    if (signUpError) {
      setError(authErrorHe(signUpError.message));
      setBusy(false);
      return;
    }
    if (data.session) {
      window.location.assign(next); // project auto-confirms emails: already signed in
      return;
    }
    setBusy(false);
    setConfirmSent(true);
  };

  return (
    <AuthShell
      title="פתיחת משרד חדש"
      subtitle="חשבון חדש יוצר משרד חדש שבו אתם הבעלים"
      footer={
        <>
          כבר יש לכם חשבון?{' '}
          <Link href="/login" className="font-semibold text-blue-600 hover:text-blue-700">
            התחברות
          </Link>
        </>
      }
    >
      {error && <FormMessage kind="error">{error}</FormMessage>}

      {confirmSent ? (
        <FormMessage kind="success">
          כמעט סיימנו! שלחנו הודעת אימות אל <span dir="ltr" className="font-semibold">{email.trim()}</span>. לחצו על הקישור שבה כדי להפעיל את החשבון.
        </FormMessage>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-slate-700">שם המשרד</span>
            <input
              type="text"
              value={orgName}
              onChange={(e) => setOrgName(e.target.value)}
              className="input-base"
              placeholder="לדוגמה: משרד כהן ראיית חשבון"
              maxLength={200}
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-slate-700">שם מלא</span>
            <input
              type="text"
              autoComplete="name"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              className="input-base"
              maxLength={200}
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-slate-700">אימייל</span>
            <input
              type="email"
              required
              autoComplete="email"
              dir="ltr"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="input-base text-left"
              placeholder="name@office.co.il"
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-slate-700">סיסמה</span>
            <input
              type="password"
              required
              minLength={MIN_PASSWORD}
              autoComplete="new-password"
              dir="ltr"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="input-base text-left"
            />
            <span className="block text-xs text-slate-400">לפחות {MIN_PASSWORD} תווים</span>
          </label>

          <button
            type="submit"
            disabled={busy}
            className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white rounded-xl py-2.5 text-sm font-semibold transition-colors shadow-sm"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
            יצירת חשבון
          </button>
        </form>
      )}
    </AuthShell>
  );
}

export default function SignupPage() {
  return (
    <Suspense fallback={null}>
      <SignupForm />
    </Suspense>
  );
}
