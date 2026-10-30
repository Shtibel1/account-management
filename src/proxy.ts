import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { AUTH_PAGES, classifyPath, isPublicApi, loginRedirectPath, safeNextPath } from '@/lib/routeAccess';
import { isMisconfiguredProduction, isSupabaseConfigured, MISCONFIGURED_MESSAGE, supabaseAnonKey, supabaseUrl } from '@/lib/supabaseConfig';

/**
 * Next 16 Proxy (formerly middleware): refreshes the Supabase cookie session and requires it for
 * the dashboard and the API. Public paths are listed in src/lib/routeAccess.ts. API routes also
 * check access to the specific resource themselves (src/lib/auth.ts) - this is only the first gate.
 */
export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const kind = classifyPath(pathname);

  // Webhooks and the lead form authenticate themselves; no session work at all.
  if (isPublicApi(pathname)) return NextResponse.next();

  if (isMisconfiguredProduction()) {
    if (kind === 'public' && !AUTH_PAGES.has(pathname)) return NextResponse.next();
    if (kind === 'api') return NextResponse.json({ error: MISCONFIGURED_MESSAGE }, { status: 503 });
    return new NextResponse('השירות אינו מוגדר כראוי (Supabase). פנה למנהל המערכת.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  // Local mock mode (no Supabase env, not production): no authentication, as before.
  if (!isSupabaseConfigured()) return NextResponse.next();

  let response = NextResponse.next({ request });
  const supabase = createServerClient(supabaseUrl()!, supabaseAnonKey()!, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookiesToSet: { name: string; value: string; options?: object }[]) => {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options as Parameters<typeof response.cookies.set>[2])
        );
      },
    },
  });

  // getUser() validates the token with Supabase Auth (and refreshes it via setAll when needed).
  let userId: string | null = null;
  try {
    const { data } = await supabase.auth.getUser();
    userId = data.user?.id ?? null;
  } catch (err) {
    console.error('[proxy] Session check failed:', err);
  }

  const withSessionCookies = (res: NextResponse): NextResponse => {
    response.cookies.getAll().forEach((cookie) => res.cookies.set(cookie));
    return res;
  };

  if (kind === 'public') {
    if (userId && AUTH_PAGES.has(pathname)) {
      const next = safeNextPath(request.nextUrl.searchParams.get('next'));
      return withSessionCookies(NextResponse.redirect(new URL(next, request.url)));
    }
    return response;
  }

  if (!userId) {
    if (kind === 'api') {
      return withSessionCookies(NextResponse.json({ error: 'נדרשת התחברות' }, { status: 401 }));
    }
    return withSessionCookies(NextResponse.redirect(new URL(loginRedirectPath(pathname, search), request.url)));
  }

  return response;
}

export const config = {
  matcher: [
    // Every API route (even ones whose last segment looks like a file name).
    '/api/:path*',
    // Everything else except Next internals and static files.
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt|xml|webmanifest|map|woff2?|ttf|css|js|mjs)$).*)',
  ],
};
