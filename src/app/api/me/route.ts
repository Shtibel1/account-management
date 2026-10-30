import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { loadMemberships, requireUser } from '@/lib/auth';
import type { MeResponse } from '@/shared/authModel';

export const dynamic = 'force-dynamic';

/** The signed-in user and their organizations (sidebar, clients page). */
export async function GET() {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  const ctx = auth.value;

  if (ctx.mock) {
    const body: MeResponse = {
      mock: true,
      user: ctx.user,
      organizations: [{ id: 'mock-org', name: 'מצב סימולציה מקומי', role: 'owner' }],
      currentOrgId: null,
    };
    return NextResponse.json(body);
  }

  try {
    const memberships = await loadMemberships(ctx);
    const orgIds = memberships.map((m) => m.orgId);
    const names = new Map<string, string>();
    if (orgIds.length > 0) {
      const { data, error } = await supabase.from('organizations').select('id, name').in('id', orgIds);
      if (error) throw new Error(`Failed to load organizations: ${error.message}`);
      for (const org of (data ?? []) as { id: string; name: string }[]) names.set(org.id, org.name);
    }

    const body: MeResponse = {
      mock: false,
      user: ctx.user,
      organizations: memberships.map((m) => ({ id: m.orgId, name: names.get(m.orgId) ?? '', role: m.role })),
      currentOrgId: memberships[0]?.orgId ?? null,
    };
    return NextResponse.json(body);
  } catch (err) {
    console.error('[me] Failed to load the user organizations:', err);
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
