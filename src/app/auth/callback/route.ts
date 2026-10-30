import { NextResponse, type NextRequest } from 'next/server';
import type { EmailOtpType } from '@supabase/supabase-js';
import { createClient } from '@/utils/supabase/server';
import { safeNextPath } from '@/lib/routeAccess';
import { isSupabaseConfigured } from '@/lib/supabaseConfig';
import { redirectLocation, siteOriginFor } from '@/lib/siteUrl';

export const dynamic = 'force-dynamic';

const OTP_TYPES: EmailOtpType[] = ['signup', 'invite', 'magiclink', 'recovery', 'email_change', 'email'];

/**
 * Landing URL for Supabase auth emails (signup confirmation, magic link, invite) and PKCE redirects.
 *   ?code=...                       PKCE (magic link / signup started in this browser)
 *   ?token_hash=...&type=...        email templates using {{ .TokenHash }} (works in any browser)
 * Without either, the tokens are in the URL fragment (implicit invite links), which only the
 * browser can read: /auth/complete handles that.
 */
export async function GET(request: NextRequest) {
  const url = request.nextUrl;
  const next = safeNextPath(url.searchParams.get('next'));
  // Never build the Location from request.url: behind Amplify it is the internal localhost:3000.
  const origin = siteOriginFor(request);
  const redirect = (path: string) =>
    new NextResponse(null, { status: 307, headers: { Location: redirectLocation(path, origin) } });
  const fail = (reason: string) =>
    redirect(`/login?error=${encodeURIComponent(reason)}&next=${encodeURIComponent(next)}`);

  if (!isSupabaseConfigured()) return redirect(next);

  const code = url.searchParams.get('code');
  const tokenHash = url.searchParams.get('token_hash');
  const type = url.searchParams.get('type') as EmailOtpType | null;
  const providerError = url.searchParams.get('error_description') || url.searchParams.get('error');
  if (providerError) return fail(providerError);

  try {
    const supabase = await createClient();
    if (code) {
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      if (error) return fail(error.message);
      return redirect(next);
    }
    if (tokenHash && type && OTP_TYPES.includes(type)) {
      const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
      if (error) return fail(error.message);
      return redirect(next);
    }
  } catch (err) {
    console.error('[auth/callback] Failed to complete sign-in:', err);
    return fail('ההתחברות נכשלה');
  }

  // Implicit-flow links carry the session in the fragment; the browser keeps it across this redirect.
  return redirect(`/auth/complete?next=${encodeURIComponent(next)}`);
}
