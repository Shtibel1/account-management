import { NextResponse, type NextRequest } from 'next/server';
import type { EmailOtpType } from '@supabase/supabase-js';
import { createClient } from '@/utils/supabase/server';
import { safeNextPath } from '@/lib/routeAccess';
import { isSupabaseConfigured } from '@/lib/supabaseConfig';

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
  const fail = (reason: string) =>
    NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(reason)}&next=${encodeURIComponent(next)}`, request.url));

  if (!isSupabaseConfigured()) return NextResponse.redirect(new URL(next, request.url));

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
      return NextResponse.redirect(new URL(next, request.url));
    }
    if (tokenHash && type && OTP_TYPES.includes(type)) {
      const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
      if (error) return fail(error.message);
      return NextResponse.redirect(new URL(next, request.url));
    }
  } catch (err) {
    console.error('[auth/callback] Failed to complete sign-in:', err);
    return fail('ההתחברות נכשלה');
  }

  // Implicit-flow links carry the session in the fragment; the browser keeps it across this redirect.
  return NextResponse.redirect(new URL(`/auth/complete?next=${encodeURIComponent(next)}`, request.url));
}
