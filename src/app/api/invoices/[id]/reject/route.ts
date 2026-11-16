import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { requireInvoiceAccess } from '@/lib/auth';
import { dbErrorResponse, readJsonObject, transitionInvoice } from '@/lib/invoiceTransitions';
import { REJECTABLE_STATUSES, transitionRefusedMessage } from '@/shared/invoiceStatus';
import type { InvoiceStatus } from '@/shared/types';

export const dynamic = 'force-dynamic';

/** Longest rejection reason (matches the invoices.reject_reason check). */
const MAX_REJECT_REASON = 500;

/** PostgREST / Postgres "no such column": the reject_reason migration is not applied yet. */
function isMissingColumn(error: { code?: string | null } | null | undefined): boolean {
  return error?.code === 'PGRST204' || error?.code === '42703';
}

/**
 * "לא מאושרת": marks an invoice in review (or a failed document) as rejected. Rejected invoices
 * are never duplicate candidates and never exported. Body (optional): { reason?: string } (up to
 * 500 characters), stored in invoices.reject_reason and logged in invoice_status_events.
 * → 200 { success, status: 'rejected' } · 400 bad reason · 409 not rejectable / changed meanwhile
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const access = await requireInvoiceAccess<{ id: string; client_id: string; status: InvoiceStatus }>(id, 'id, client_id, status');
  if (!access.ok) return access.response;

  const parsed = await readJsonObject<{ reason?: unknown }>(request, { optional: true });
  if (!parsed.ok) return parsed.response;
  const rawReason = parsed.body.reason;
  if (rawReason !== undefined && rawReason !== null && typeof rawReason !== 'string') {
    return NextResponse.json({ error: 'סיבת הדחייה חייבת להיות טקסט' }, { status: 400 });
  }
  const reason = typeof rawReason === 'string' ? rawReason.trim() : '';
  if (reason.length > MAX_REJECT_REASON) {
    return NextResponse.json({ error: `סיבת הדחייה ארוכה מדי (עד ${MAX_REJECT_REASON} תווים)` }, { status: 400 });
  }

  const current = access.value.invoice.status;
  if (!REJECTABLE_STATUSES.includes(current)) {
    return NextResponse.json({ error: transitionRefusedMessage('reject', current), status: current }, { status: 409 });
  }

  try {
    let outcome = await transitionInvoice(supabase, id, REJECTABLE_STATUSES, {
      status: 'rejected',
      reject_reason: reason || null,
    });
    if (!outcome.ok && outcome.reason === 'db' && isMissingColumn(outcome.error)) {
      // Database without the qa2_ui2 migration: a reason cannot be stored yet
      if (reason) {
        return NextResponse.json(
          { error: 'שמירת סיבת דחייה אינה זמינה עדיין (נדרש עדכון של מסד הנתונים). נסו שוב ללא סיבה.' },
          { status: 503 }
        );
      }
      outcome = await transitionInvoice(supabase, id, REJECTABLE_STATUSES, { status: 'rejected' });
    }
    if (!outcome.ok) {
      if (outcome.reason === 'conflict') {
        return NextResponse.json(
          { error: transitionRefusedMessage('reject', outcome.currentStatus), status: outcome.currentStatus },
          { status: 409 }
        );
      }
      return dbErrorResponse(outcome.error, 'שגיאה בסימון החשבונית כלא מאושרת');
    }
    if (!access.value.ctx.mock) {
      // Audit trail next to reopens (best-effort: the rejection itself already succeeded)
      const { error: eventErr } = await supabase.from('invoice_status_events').insert({
        invoice_id: id,
        from_status: current,
        to_status: 'rejected',
        action: 'reject',
        actor_id: access.value.ctx.user.id,
        reason: reason || null,
      });
      if (eventErr) console.error(`[invoices/reject] Failed to log the rejection of invoice ${id}:`, eventErr);
    }
    return NextResponse.json({ success: true, status: 'rejected' });
  } catch (err) {
    console.error(`[invoices/reject] Failed to reject invoice ${id}:`, err);
    return NextResponse.json({ error: 'שגיאה בסימון החשבונית כלא מאושרת' }, { status: 500 });
  }
}
