import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { BankTableMissingError, loadBankOverview } from '@/lib/bankTransactions';

// Statement lines of one client + matchable invoices + candidates for the unmatched debits.
export async function GET(request: Request) {
  const clientId = new URL(request.url).searchParams.get('clientId');
  if (!clientId) {
    return NextResponse.json({ error: 'חסר לקוח' }, { status: 400 });
  }

  try {
    const overview = await loadBankOverview(supabase, clientId);
    return NextResponse.json(overview);
  } catch (err) {
    if (err instanceof BankTableMissingError) {
      // Migration not applied yet: render an empty page with a notice instead of failing.
      console.error('[bank] GET:', err.message);
      return NextResponse.json({ transactions: [], invoices: [], candidates: {}, setupRequired: true });
    }
    console.error('[bank] GET failed:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
