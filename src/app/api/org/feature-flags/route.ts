import { NextResponse } from 'next/server';
import { loadMemberships, requireOrgOwner, requireUser, type AuthContext } from '@/lib/auth';
import { getOrgFlagStates, setOrgFlag } from '@/lib/featureFlags';
import { isFeatureFlag, type OrgFeatureFlagsResponse } from '@/shared/featureFlags';

export const dynamic = 'force-dynamic';

/**
 * "תכונות ניסיוניות" settings (office owners only).
 *   GET ?orgId=                         every flag: effective value, env default, office override
 *   PUT { orgId?, flag, enabled }       enabled: true / false, or null = back to the default
 * orgId defaults to the caller's first office. Not available in local mock mode.
 */

function mockUnavailable() {
  return NextResponse.json({ error: 'הגדרת תכונות אינה זמינה במצב סימולציה מקומי (FEATURE_FLAGS_DEFAULT בלבד)' }, { status: 400 });
}

async function resolveOrgId(ctx: AuthContext, requested: unknown): Promise<unknown> {
  if (typeof requested === 'string' && requested) return requested;
  return (await loadMemberships(ctx))[0]?.orgId ?? null;
}

export async function GET(request: Request) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  if (auth.value.mock) return mockUnavailable();

  try {
    const owner = await requireOrgOwner(await resolveOrgId(auth.value, new URL(request.url).searchParams.get('orgId')), auth.value);
    if (!owner.ok) return owner.response;
    const body: OrgFeatureFlagsResponse = { orgId: owner.value.orgId, flags: await getOrgFlagStates(owner.value.orgId) };
    return NextResponse.json(body);
  } catch (err) {
    console.error('[org/feature-flags] Failed to load flags:', err);
    return NextResponse.json({ error: 'שגיאה בטעינת התכונות' }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  if (auth.value.mock) return mockUnavailable();

  let body: { orgId?: unknown; flag?: unknown; enabled?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'גוף הבקשה אינו JSON תקין' }, { status: 400 });
  }
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'גוף בקשה לא תקין' }, { status: 400 });
  if (!isFeatureFlag(body.flag)) return NextResponse.json({ error: 'תכונה לא מוכרת' }, { status: 400 });
  if (body.enabled !== null && typeof body.enabled !== 'boolean') {
    return NextResponse.json({ error: 'enabled חייב להיות true, false או null' }, { status: 400 });
  }

  try {
    const owner = await requireOrgOwner(await resolveOrgId(auth.value, body.orgId), auth.value);
    if (!owner.ok) return owner.response;
    await setOrgFlag(owner.value.orgId, body.flag, body.enabled, auth.value.user.id);
    console.log(`[org/feature-flags] ${owner.value.orgId}: ${body.flag} = ${String(body.enabled)} by ${auth.value.user.id}`);
    const response: OrgFeatureFlagsResponse = { orgId: owner.value.orgId, flags: await getOrgFlagStates(owner.value.orgId) };
    return NextResponse.json(response);
  } catch (err) {
    console.error('[org/feature-flags] Failed to save flag:', err);
    return NextResponse.json({ error: 'שגיאה בשמירת התכונה' }, { status: 500 });
  }
}
