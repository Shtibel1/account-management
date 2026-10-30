import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { BankTableMissingError, runAutoMatch } from '@/lib/bankTransactions';
import { requireClientAccess } from '@/lib/auth';

// Re-runs auto-matching for a client (e.g. after more invoices were approved).
export async function POST(request: Request) {
  try {
    const { clientId } = (await request.json()) as { clientId?: string };
    if (!clientId) {
      return NextResponse.json({ error: 'חסר לקוח' }, { status: 400 });
    }
    const access = await requireClientAccess(clientId);
    if (!access.ok) return access.response;
    const result = await runAutoMatch(supabase, clientId);
    return NextResponse.json(result);
  } catch (err) {
    console.error('[bank] Auto-match failed:', err);
    const status = err instanceof BankTableMissingError ? 503 : 500;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status }
    );
  }
}
