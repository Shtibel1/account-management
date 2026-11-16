import { NextResponse } from 'next/server';
import { requireInvoiceAccess } from '@/lib/auth';
import { requireFeature } from '@/lib/featureFlags';
import { listInvoiceNotifications } from '@/lib/returns';

export const dynamic = 'force-dynamic';

/** Notification attempts sent to the client about this invoice (accountant_review_loop; 404 while off). */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const access = await requireInvoiceAccess(id);
  if (!access.ok) return access.response;
  const gate = await requireFeature(access.value.orgId, 'accountant_review_loop');
  if (gate) return gate;

  try {
    return NextResponse.json(await listInvoiceNotifications(id));
  } catch (err) {
    console.error(`[invoices/notifications] Failed to list notifications for ${id}:`, err);
    return NextResponse.json({ error: 'שגיאה בטעינת היסטוריית ההודעות' }, { status: 500 });
  }
}
