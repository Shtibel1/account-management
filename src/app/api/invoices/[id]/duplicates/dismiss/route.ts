import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { DuplicateDismissalError, dismissDuplicate } from '@/lib/duplicates';
import { requireInvoiceAccess } from '@/lib/auth';

// Reviewer says "not a duplicate": remember the pair and clear the flag on both invoices.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // dismissDuplicate() treats an otherInvoiceId of a different client as not found (uniform 404),
  // so access to `id` covers both without revealing ids of other offices.
  const access = await requireInvoiceAccess(id);
  if (!access.ok) return access.response;

  try {
    const body = (await request.json().catch(() => ({}))) as { otherInvoiceId?: unknown } | null;
    const otherInvoiceId = typeof body?.otherInvoiceId === 'string' ? body.otherInvoiceId.trim() : '';
    if (!otherInvoiceId) {
      return NextResponse.json({ error: 'חסר מזהה החשבונית הכפולה' }, { status: 400 });
    }

    const validationFlags = await dismissDuplicate(supabase, id, otherInvoiceId);
    return NextResponse.json({ success: true, validation_flags: validationFlags });
  } catch (err) {
    if (err instanceof DuplicateDismissalError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error(`[Duplicates API] Failed to dismiss duplicate for invoice ${id}:`, err);
    return NextResponse.json({ error: 'סימון "לא כפילות" נכשל' }, { status: 500 });
  }
}
