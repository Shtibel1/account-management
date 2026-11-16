import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { isUuid, requireClientAccess, requireUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/** One log row incl. the (already redacted, truncated) request / response bodies. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  if (!auth.value.mock && !isUuid(id)) return NextResponse.json({ error: 'הרשומה לא נמצאה' }, { status: 404 });

  const { data, error } = await supabase.from('integration_logs').select('*').eq('id', id).maybeSingle();
  if (error) {
    console.error(`[Integration logs API] Failed to load log ${id}:`, error.message);
    return NextResponse.json({ error: 'שגיאה בטעינת הרשומה' }, { status: 500 });
  }
  if (!data) return NextResponse.json({ error: 'הרשומה לא נמצאה' }, { status: 404 });

  const access = await requireClientAccess((data as { client_id: string }).client_id, auth.value);
  if (!access.ok) {
    // The row exists but belongs to another office: don't reveal more than "not found".
    return access.response.status === 403 || access.response.status === 404
      ? NextResponse.json({ error: 'הרשומה לא נמצאה' }, { status: 404 })
      : access.response;
  }
  return NextResponse.json(data);
}
