import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { accessibleClientIds, requireClientAccess, requireUser } from '@/lib/auth';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const clientId = searchParams.get('clientId');
  const status = searchParams.get('status');

  const auth = await requireUser();
  if (!auth.ok) return auth.response;

  try {
    let query = supabase.from('invoices').select('*').order('created_at', { ascending: false });

    if (clientId) {
      const access = await requireClientAccess(clientId, auth.value);
      if (!access.ok) return access.response;
      query = query.eq('client_id', clientId);
    } else {
      // Only the clients of the user's organizations (null = mock mode, no filter).
      const ids = await accessibleClientIds(auth.value);
      if (ids !== null) {
        if (ids.length === 0) return NextResponse.json([]);
        query = query.in('client_id', ids);
      }
    }
    if (status) {
      query = query.eq('status', status);
    }

    const { data, error } = await query;

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json(data || []);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
