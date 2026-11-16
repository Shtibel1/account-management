import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { requireClientAccess } from '@/lib/auth';
import { RULE_COLUMNS } from '@/lib/learning';

/** Rules the system learned from corrections at this client (GET ?clientId=). */
export async function GET(request: Request) {
  const clientId = new URL(request.url).searchParams.get('clientId');
  if (!clientId) return NextResponse.json({ error: 'חסר לקוח' }, { status: 400 });

  const access = await requireClientAccess(clientId);
  if (!access.ok) return access.response;

  try {
    let query = supabase.from('extraction_learned_rules').select(RULE_COLUMNS).eq('client_id', clientId);
    // The office of the client (another office's rules never show, even for the same client id)
    if (access.value.orgId) query = query.eq('org_id', access.value.orgId);
    const { data, error } = await query.order('updated_at', { ascending: false }).limit(200);
    if (error) throw error;
    const rules = data ?? [];
    return NextResponse.json({ rules, active: rules.filter((r: { active?: boolean }) => r.active).length });
  } catch (err) {
    console.error(`[learned-rules] Failed to load the rules of client ${clientId}:`, err);
    return NextResponse.json({ error: 'שגיאה בטעינת הכללים שנלמדו' }, { status: 500 });
  }
}
