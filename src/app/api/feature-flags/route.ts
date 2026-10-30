import { NextResponse } from 'next/server';
import { hasOrgAccess, isUuid, loadMemberships, requireClientAccess, requireUser } from '@/lib/auth';
import { getOrgFlags } from '@/lib/featureFlags';
import type { FeatureFlagsResponse } from '@/shared/featureFlags';

export const dynamic = 'force-dynamic';

/**
 * Effective feature flags for one office (any member).
 *   ?clientId=<uuid>  the office of that client (must be accessible)
 *   ?orgId=<uuid>     that office (must be a member)
 *   (none)            the caller's current office (oldest membership)
 * Mock mode: env defaults only (orgId null).
 */
export async function GET(request: Request) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  const ctx = auth.value;
  const params = new URL(request.url).searchParams;
  const clientId = params.get('clientId');
  const requestedOrg = params.get('orgId');

  try {
    let orgId: string | null = null;
    if (clientId) {
      const access = await requireClientAccess(clientId, ctx);
      if (!access.ok) return access.response;
      orgId = access.value.orgId;
    } else if (requestedOrg && !ctx.mock) {
      if (!isUuid(requestedOrg)) return NextResponse.json({ error: 'המשרד לא נמצא' }, { status: 404 });
      if (!(await hasOrgAccess(ctx, requestedOrg))) {
        return NextResponse.json({ error: 'אין הרשאה למשרד זה' }, { status: 403 });
      }
      orgId = requestedOrg;
    } else if (!ctx.mock) {
      orgId = (await loadMemberships(ctx))[0]?.orgId ?? null;
    }

    const body: FeatureFlagsResponse = { orgId, flags: await getOrgFlags(orgId) };
    return NextResponse.json(body);
  } catch (err) {
    console.error('[feature-flags] Failed to resolve flags:', err);
    return NextResponse.json({ error: 'שגיאה בטעינת הגדרות התכונות' }, { status: 500 });
  }
}
