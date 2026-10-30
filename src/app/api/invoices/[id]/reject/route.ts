import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { requireInvoiceAccess } from '@/lib/auth';
import { dbErrorResponse, readJsonObject, transitionInvoice } from '@/lib/invoiceTransitions';
import { REJECTABLE_STATUSES, transitionRefusedMessage } from '@/shared/invoiceStatus';
import type { InvoiceStatus } from '@/shared/types';

export const dynamic = 'force-dynamic';

/**
 * "לא מאושרת": marks an invoice in review (or a failed document) as rejected. Rejected invoices
 * are never duplicate candidates and never exported. Body (optional): {}.
 * → 200 { success, status: 'rejected' } · 409 not rejectable / changed meanwhile
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const access = await requireInvoiceAccess<{ id: string; client_id: string; status: InvoiceStatus }>(id, 'id, client_id, status');
  if (!access.ok) return access.response;

  const parsed = await readJsonObject(request, { optional: true });
  if (!parsed.ok) return parsed.response;

  const current = access.value.invoice.status;
  if (!REJECTABLE_STATUSES.includes(current)) {
    return NextResponse.json({ error: transitionRefusedMessage('reject', current), status: current }, { status: 409 });
  }

  try {
    const outcome = await transitionInvoice(supabase, id, REJECTABLE_STATUSES, { status: 'rejected' });
    if (!outcome.ok) {
      if (outcome.reason === 'conflict') {
        return NextResponse.json(
          { error: transitionRefusedMessage('reject', outcome.currentStatus), status: outcome.currentStatus },
          { status: 409 }
        );
      }
      return dbErrorResponse(outcome.error, 'שגיאה בסימון החשבונית כלא מאושרת');
    }
    return NextResponse.json({ success: true, status: 'rejected' });
  } catch (err) {
    console.error(`[invoices/reject] Failed to reject invoice ${id}:`, err);
    return NextResponse.json({ error: 'שגיאה בסימון החשבונית כלא מאושרת' }, { status: 500 });
  }
}
