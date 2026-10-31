import Link from 'next/link';
import { Logo } from '@/components/ui/Logo';

interface Props {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}

/** Centered card layout shared by /login, /signup and /auth/complete. */
export function AuthShell({ title, subtitle, children, footer }: Props) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-100 px-4 py-12">
      <div className="w-full max-w-md space-y-6">
        <div className="flex justify-center">
          <Link href="/" aria-label="לדף הבית">
            <Logo size="lg" />
          </Link>
        </div>
        <div className="card p-6 sm:p-8 space-y-6">
          <div className="space-y-1 text-center">
            <h1 className="text-2xl font-bold text-slate-900">{title}</h1>
            {subtitle && <p className="text-sm text-slate-500">{subtitle}</p>}
          </div>
          {children}
        </div>
        {footer && <div className="text-center text-sm text-slate-600">{footer}</div>}
      </div>
    </div>
  );
}

export function FormMessage({ kind, children }: { kind: 'error' | 'success' | 'info'; children: React.ReactNode }) {
  const styles = {
    error: 'bg-red-50 border-red-200 text-red-700',
    success: 'bg-emerald-50 border-emerald-200 text-emerald-700',
    info: 'bg-amber-50 border-amber-200 text-amber-800',
  }[kind];
  return (
    <div role={kind === 'error' ? 'alert' : 'status'} className={`border rounded-xl px-4 py-3 text-sm ${styles}`}>
      {children}
    </div>
  );
}

/** Supabase auth error messages -> Hebrew. */
export function authErrorHe(message: string | null | undefined): string {
  const m = (message ?? '').toLowerCase();
  if (!m) return 'אירעה שגיאה. נסה שוב.';
  if (m.includes('invalid login credentials')) return 'אימייל או סיסמה שגויים';
  if (m.includes('email not confirmed')) return 'יש לאשר את כתובת האימייל לפני ההתחברות (בדוק את תיבת הדואר)';
  if (m.includes('user already registered') || m.includes('already been registered')) return 'כבר קיים חשבון עם אימייל זה. נסה להתחבר.';
  if (m.includes('password should be at least') || m.includes('weak password')) return 'הסיסמה חלשה מדי (לפחות 8 תווים)';
  if (m.includes('signups not allowed') || m.includes('user not found') || m.includes('otp_disabled')) return 'לא נמצא חשבון עם אימייל זה';
  if (m.includes('rate limit') || m.includes('too many') || m.includes('security purposes')) return 'יותר מדי ניסיונות. נסה שוב בעוד כמה דקות.';
  if (m.includes('expired') || (m.includes('invalid') && m.includes('token'))) return 'הקישור פג תוקף או אינו תקין. בקש קישור חדש.';
  if (m.includes('failed to fetch') || m.includes('network')) return 'אין חיבור לשרת. בדקו את החיבור לאינטרנט ונסו שוב.';
  if (m.includes('invalid email') || m.includes('unable to validate email')) return 'כתובת האימייל אינה תקינה';
  // Never show Supabase's English text as is: an unknown message gets a generic Hebrew one (details in the console)
  if (/[֐-׿]/.test(message ?? '')) return message as string;
  console.warn('[auth] Unmapped auth error:', message);
  return 'אירעה שגיאה. נסו שוב.';
}
