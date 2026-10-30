import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { BankTableMissingError, runAutoMatch } from '@/lib/bankTransactions';
import { requireClientAccess } from '@/lib/auth';

// Re-runs auto-matching for a client (e.g. after more invoices were approved).
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'גוף הבקשה אינו JSON תקין' }, { status: 400 });
  }
  const clientId =
    body && typeof body === 'object' && !Array.isArray(body) ? (body as { clientId?: unknown }).clientId : undefined;
  if (typeof clientId !== 'string' || !clientId) {
    return NextResponse.json({ error: 'חסר לקוח' }, { status: 400 });
  }

  const access = await requireClientAccess(clientId);
  if (!access.ok) return access.response;

  try {
    const result = await runAutoMatch(supabase, clientId);
    return NextResponse.json(result);
  } catch (err) {
    console.error('[bank] Auto-match failed:', err);
    if (err instanceof BankTableMissingError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    return NextResponse.json({ error: 'ההתאמה האוטומטית נכשלה. נסו שוב.' }, { status: 500 });
  }
}
