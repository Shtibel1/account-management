import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { BankTableMissingError, loadMissingExportPage } from '@/lib/bankTransactions';
import { requireClientAccess } from '@/lib/auth';

// One page of a client's unmatched debits for the "missing invoices" export: the sheet's columns
// only, keyset paged (after = the previous page's `next`), so each call costs the same however
// many lines the client has and however far the export is.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const clientId = params.get('clientId');
  if (!clientId) {
    return NextResponse.json({ error: 'חסר לקוח' }, { status: 400 });
  }
  const after = params.get('after');
  if (after !== null && !UUID.test(after)) {
    return NextResponse.json({ error: 'פרמטר after לא תקין' }, { status: 400 });
  }

  const access = await requireClientAccess(clientId);
  if (!access.ok) return access.response;

  try {
    return NextResponse.json(await loadMissingExportPage(supabase, clientId, after ? after.toLowerCase() : null));
  } catch (err) {
    if (err instanceof BankTableMissingError) {
      console.error('[bank] GET missing:', err.message);
      return NextResponse.json({ lines: [], next: null });
    }
    console.error('[bank] GET missing failed:', err);
    return NextResponse.json({ error: 'שגיאה בטעינת התנועות לייצוא' }, { status: 500 });
  }
}
