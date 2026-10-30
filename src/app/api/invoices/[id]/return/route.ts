import { NextResponse } from 'next/server';
import { requireInvoiceAccess } from '@/lib/auth';
import { requireFeature } from '@/lib/featureFlags';
import { ReturnInvoiceError, returnInvoiceToClient } from '@/lib/returns';
import { validateReturnReason } from '@/shared/returns';

export const dynamic = 'force-dynamic';

/**
 * "החזר ללקוח" (feature flag accountant_review_loop; 404 while it is off for the office).
 * Body: { reasonCode, note? }. Marks the invoice 'returned' with the reason and notifies the
 * client by email / WhatsApp (every attempt logged in client_notifications).
 * → 200 { invoice, notifications: [{ channel, to, status, error }] } · 400 bad reason · 409 not returnable
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const access = await requireInvoiceAccess(id);
  if (!access.ok) return access.response;
  const gate = await requireFeature(access.value.orgId, 'accountant_review_loop');
  if (gate) return gate;

  let body: { reasonCode?: unknown; note?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'גוף הבקשה אינו JSON תקין' }, { status: 400 });
  }
  const reason = validateReturnReason({ code: body?.reasonCode, note: body?.note });
  if (!reason.ok) return NextResponse.json({ error: reason.error }, { status: 400 });

  try {
    const ctx = access.value.ctx;
    const result = await returnInvoiceToClient({
      invoiceId: id,
      orgId: access.value.orgId,
      userId: ctx.mock ? null : ctx.user.id,
      reason: { code: reason.code, text: reason.text },
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof ReturnInvoiceError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error(`[invoices/return] Failed to return invoice ${id}:`, err);
    return NextResponse.json({ error: 'שגיאה בהחזרת החשבונית ללקוח' }, { status: 500 });
  }
}
