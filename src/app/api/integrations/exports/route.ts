import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { requireClientAccess } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/** Per-invoice export status of a client. Query: clientId (required), pluginId?. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const access = await requireClientAccess(url.searchParams.get('clientId'));
  if (!access.ok) return access.response;
  const pluginId = url.searchParams.get('pluginId');

  try {
    let query = supabase.from('invoice_exports').select('*').eq('client_id', access.value.clientId);
    if (pluginId) query = query.eq('plugin_id', pluginId);
    const { data, error } = await query.order('updated_at', { ascending: false }).limit(1000);
    if (error) throw new Error(error.message);
    return NextResponse.json({ exports: data ?? [] });
  } catch (err) {
    console.error('[Integration exports API] Failed to load export status:', err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: 'שגיאה בטעינת סטטוס הייצוא' }, { status: 500 });
  }
}
