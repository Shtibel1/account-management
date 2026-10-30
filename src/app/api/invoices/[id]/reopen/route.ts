import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { hasOrgAccess, requireInvoiceAccess } from '@/lib/auth';
import { dbErrorResponse, readJsonObject, transitionInvoice } from '@/lib/invoiceTransitions';
import { REOPENABLE_STATUSES, reopenRequiresOwner, transitionRefusedMessage } from '@/shared/invoiceStatus';
import type { InvoiceStatus } from '@/shared/types';

export const dynamic = 'force-dynamic';

/**
 * Explicit reopen: moves an approved / rejected / returned / exported invoice back to 'review'.
 * Exported invoices were already posted to the books, so only an office owner may reopen them,
 * and every reopen is logged in invoice_status_events (DB function reopen_invoice).
 * Body: { reason? } → 200 { success, status: 'review', from } · 403 not owner · 409 not reopenable
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const access = await requireInvoiceAccess<{ id: string; client_id: string; status: InvoiceStatus }>(id, 'id, client_id, status');
  if (!access.ok) return access.response;
  const { ctx, orgId, invoice } = access.value;

  const parsed = await readJsonObject<{ reason?: unknown }>(request, { optional: true });
  if (!parsed.ok) return parsed.response;
  const reason = parsed.body.reason;
  if (reason !== undefined && reason !== null && (typeof reason !== 'string' || reason.length > 500)) {
    return NextResponse.json({ error: 'סיבת הפתיחה מחדש חייבת להיות טקסט של עד 500 תווים' }, { status: 400 });
  }

  if (!REOPENABLE_STATUSES.includes(invoice.status)) {
    return NextResponse.json({ error: transitionRefusedMessage('reopen', invoice.status), status: invoice.status }, { status: 409 });
  }
  if (reopenRequiresOwner(invoice.status) && !(await hasOrgAccess(ctx, orgId, 'owner'))) {
    return NextResponse.json({ error: 'רק בעל המשרד יכול לפתוח מחדש חשבונית שכבר יוצאה' }, { status: 403 });
  }

  try {
    if (ctx.mock) {
      // Local mock DB has no RPC: plain conditional update.
      const outcome = await transitionInvoice(supabase, id, REOPENABLE_STATUSES, { status: 'review' });
      if (!outcome.ok) {
        return outcome.reason === 'conflict'
          ? NextResponse.json({ error: transitionRefusedMessage('reopen', outcome.currentStatus) }, { status: 409 })
          : dbErrorResponse(outcome.error, 'שגיאה בפתיחת החשבונית מחדש');
      }
      return NextResponse.json({ success: true, status: 'review', from: invoice.status });
    }

    const { data, error } = await supabase.rpc('reopen_invoice', {
      p_invoice_id: id,
      p_actor_id: ctx.user.id,
      p_reason: typeof reason === 'string' ? reason.trim() : null,
    });
    if (error) {
      if ((error.message ?? '').includes('invoice_not_reopenable')) {
        return NextResponse.json({ error: 'החשבונית שונתה בינתיים ואינה ניתנת לפתיחה מחדש' }, { status: 409 });
      }
      if (error.code === 'PGRST202' || error.code === '42883') {
        return NextResponse.json({ error: 'פתיחה מחדש אינה זמינה עדיין (נדרש עדכון של מסד הנתונים)' }, { status: 503 });
      }
      return dbErrorResponse(error, 'שגיאה בפתיחת החשבונית מחדש');
    }
    console.log(`[invoices/reopen] Invoice ${id} reopened from '${String(data)}' by ${ctx.user.id}`);
    return NextResponse.json({ success: true, status: 'review', from: data ?? invoice.status });
  } catch (err) {
    console.error(`[invoices/reopen] Failed to reopen invoice ${id}:`, err);
    return NextResponse.json({ error: 'שגיאה בפתיחת החשבונית מחדש' }, { status: 500 });
  }
}
