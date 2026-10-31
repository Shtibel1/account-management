import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { isUuid, requireClientAccess, requireUser } from '@/lib/auth';
import { forgetRule } from '@/lib/learning';

/** Forgets a learned rule (and the corrections it was learned from). */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  if (!isUuid(id)) return NextResponse.json({ error: 'הכלל לא נמצא' }, { status: 404 });

  try {
    const { data, error } = await supabase
      .from('extraction_learned_rules')
      .select('id, org_id, client_id, supplier_key, field')
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    const rule = data as { id: string; org_id: string; client_id: string; supplier_key: string; field: string } | null;
    if (!rule) return NextResponse.json({ error: 'הכלל לא נמצא' }, { status: 404 });

    // Another office's rule answers like a missing one
    const access = await requireClientAccess(rule.client_id, auth.value);
    if (!access.ok) return NextResponse.json({ error: 'הכלל לא נמצא' }, { status: 404 });
    if (access.value.orgId && access.value.orgId !== rule.org_id) {
      return NextResponse.json({ error: 'הכלל לא נמצא' }, { status: 404 });
    }

    await forgetRule(supabase, rule);
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error(`[learned-rules/${id}] DELETE failed:`, err);
    return NextResponse.json({ error: 'מחיקת הכלל נכשלה' }, { status: 500 });
  }
}
