import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { DuplicateDismissalError, dismissDuplicate } from '@/lib/duplicates';

// Reviewer says "not a duplicate": remember the pair and clear the flag on both invoices.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const body = (await request.json().catch(() => ({}))) as { otherInvoiceId?: unknown } | null;
    const otherInvoiceId = typeof body?.otherInvoiceId === 'string' ? body.otherInvoiceId.trim() : '';
    if (!otherInvoiceId) {
      return NextResponse.json({ error: 'Missing otherInvoiceId' }, { status: 400 });
    }

    const validationFlags = await dismissDuplicate(supabase, id, otherInvoiceId);
    return NextResponse.json({ success: true, validation_flags: validationFlags });
  } catch (err) {
    if (err instanceof DuplicateDismissalError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error(`[Duplicates API] Failed to dismiss duplicate for invoice ${id}:`, err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
