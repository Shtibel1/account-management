import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { BankActionSchema } from '@/shared/schemas';
import { applyBankAction, BankActionError, BankTableMissingError } from '@/lib/bankTransactions';
import { requireBankTransactionAccess } from '@/lib/auth';

// Manual match / unmatch / ignore / restore of one statement line.
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // applyBankAction() only matches invoices of the transaction's own client.
  const access = await requireBankTransactionAccess(id);
  if (!access.ok) return access.response;

  try {
    const parsed = BankActionSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: 'פעולה לא תקינה' }, { status: 400 });
    }
    const transaction = await applyBankAction(supabase, id, parsed.data);
    return NextResponse.json(transaction);
  } catch (err) {
    if (err instanceof BankActionError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error(`[bank] Action on ${id} failed:`, err);
    const status = err instanceof BankTableMissingError ? 503 : 500;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status }
    );
  }
}
