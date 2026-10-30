import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { BankActionSchema } from '@/shared/schemas';
import { applyBankAction, BankActionError, BankTableMissingError } from '@/lib/bankTransactions';
import { requireBankTransactionAccess } from '@/lib/auth';

// Manual match / unmatch / ignore / restore of one statement line.
// match: debit lines only; an invoice total outside the tolerance needs { force: true } (the UI
// asks the reviewer to confirm after a 409 with code 'amount_mismatch').
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // applyBankAction() only matches invoices of the transaction's own client.
  const access = await requireBankTransactionAccess(id);
  if (!access.ok) return access.response;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'גוף הבקשה אינו JSON תקין' }, { status: 400 });
  }
  const parsed = BankActionSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: 'פעולה לא תקינה' }, { status: 400 });
  }

  try {
    const transaction = await applyBankAction(supabase, id, parsed.data);
    return NextResponse.json(transaction);
  } catch (err) {
    if (err instanceof BankActionError) {
      return NextResponse.json(
        { error: err.message, ...(err.code ? { code: err.code } : {}), ...(err.details ? { details: err.details } : {}) },
        { status: err.status }
      );
    }
    console.error(`[bank] Action on ${id} failed:`, err);
    if (err instanceof BankTableMissingError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    return NextResponse.json({ error: 'הפעולה על התנועה נכשלה. נסו שוב.' }, { status: 500 });
  }
}
