'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { createClient } from '@/utils/supabase/client';
import { safeNextPath } from '@/lib/routeAccess';
import { AuthShell, FormMessage, authErrorHe } from '@/components/Auth/AuthShell';

/**
 * Finishes implicit-flow auth links (e.g. admin invites), whose tokens arrive in the URL fragment
 * that the server never sees. Stores the session in cookies and continues to `next`.
 */
function CompleteAuth() {
  const params = useSearchParams();
  const next = safeNextPath(params.get('next'));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const accessToken = hash.get('access_token');
    const refreshToken = hash.get('refresh_token');
    const hashError = hash.get('error_description') || hash.get('error');

    if (hashError) {
      setError(authErrorHe(hashError));
      return;
    }
    if (!accessToken || !refreshToken) {
      setError('קישור ההתחברות אינו תקין או שפג תוקפו.');
      return;
    }
    createClient()
      .auth.setSession({ access_token: accessToken, refresh_token: refreshToken })
      .then(({ error: sessionError }) => {
        if (sessionError) {
          setError(authErrorHe(sessionError.message));
          return;
        }
        window.history.replaceState(null, '', window.location.pathname);
        window.location.replace(next);
      });
  }, [next]);

  return (
    <AuthShell title="מתחברים...">
      {error ? (
        <>
          <FormMessage kind="error">{error}</FormMessage>
          <Link href="/login" className="block text-center text-sm font-semibold text-blue-600 hover:text-blue-700">
            חזרה להתחברות
          </Link>
        </>
      ) : (
        <div className="flex justify-center py-4">
          <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
        </div>
      )}
    </AuthShell>
  );
}

export default function AuthCompletePage() {
  return (
    <Suspense fallback={null}>
      <CompleteAuth />
    </Suspense>
  );
}
