import type { Metadata } from 'next';
import Link from 'next/link';
import { FileQuestion } from 'lucide-react';
import { createClient } from '@/utils/supabase/server';
import { DEFAULT_AFTER_LOGIN } from '@/lib/routeAccess';

export const metadata: Metadata = { title: 'הדף לא נמצא' };

/** Signed in? (a failed check counts as signed out: the 404 page must always render) */
async function isSignedIn(): Promise<boolean> {
  try {
    const supabase = await createClient();
    const { data } = await supabase.auth.getUser();
    return !!data?.user;
  } catch {
    return false;
  }
}

/**
 * Hebrew 404 for every unknown route (replaces Next's default English page). "Home" is the office's
 * client list for a signed-in user, the marketing page otherwise.
 */
export default async function NotFound() {
  const signedIn = await isSignedIn();
  return (
    <main className="min-h-screen flex items-center justify-center bg-slate-100 px-4" dir="rtl">
      <div className="card max-w-md w-full p-8 text-center space-y-4">
        <div className="mx-auto h-14 w-14 rounded-2xl bg-blue-50 flex items-center justify-center">
          <FileQuestion className="h-7 w-7 text-blue-600" />
        </div>
        <p className="text-sm font-semibold text-blue-600">שגיאה 404</p>
        <h1 className="text-2xl font-bold text-slate-900">הדף לא נמצא</h1>
        <p className="text-sm text-slate-500">
          הכתובת שביקשת אינה קיימת או שהועברה. אפשר לחזור לרשימת הלקוחות ולהמשיך משם.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-2 pt-2">
          {signedIn ? (
            <Link
              href={DEFAULT_AFTER_LOGIN}
              className="bg-blue-600 hover:bg-blue-700 text-white px-5 py-2 rounded-xl text-sm font-semibold transition-colors"
            >
              לדף הבית
            </Link>
          ) : (
            <>
              <Link
                href="/clients"
                className="bg-blue-600 hover:bg-blue-700 text-white px-5 py-2 rounded-xl text-sm font-semibold transition-colors"
              >
                ללקוחות המשרד
              </Link>
              <Link
                href="/"
                className="px-5 py-2 rounded-xl text-sm font-medium text-slate-600 hover:bg-slate-200 transition-colors"
              >
                לדף הבית
              </Link>
            </>
          )}
        </div>
      </div>
    </main>
  );
}
