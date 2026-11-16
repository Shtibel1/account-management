import { NextResponse } from 'next/server';
import { requireInvoiceAccess } from '@/lib/auth';
import { enqueueProcessing } from '@/lib/processingQueue';

/**
 * Queues (re)processing of an invoice the user may access and answers 202 at once. The work runs in
 * short resumable ticks (src/lib/processingQueue.ts) inside later requests: the browser's
 * /process/tick and the scheduled worker. Nothing is left running after this response (on Amplify
 * it would be frozen, QA round 3).
 *
 * Idempotent for a run that is already queued and live (the upload / retry routes queue on the
 * server themselves): 202 with that run's id and `alreadyQueued: true`, not a 409 error.
 *
 * Allowed from 'processing' (fresh upload / split part / retry, or a stuck run), 'review' and 'error'
 * (src/shared/invoiceStatus.ts, via 'reprocess'). An approved invoice must first be reopened
 * explicitly (POST /reopen: logged, owner-only for exported); its reviewed values are then kept.
 *
 * Body (all optional): `mimeType` - type hint. `fileUrl` / `tenantId` from older clients are ignored,
 * except that a tenantId that doesn't match the invoice's client is rejected.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const access = await requireInvoiceAccess(id);
  if (!access.ok) return access.response;
  const invoice = access.value.invoice;

  const body = ((await request.json().catch(() => ({}))) ?? {}) as { mimeType?: unknown; tenantId?: unknown };
  if (typeof body !== 'object') {
    return NextResponse.json({ error: 'בקשה לא תקינה' }, { status: 400 });
  }
  if (body.tenantId !== undefined && body.tenantId !== invoice.client_id) {
    return NextResponse.json({ error: 'הלקוח שנשלח אינו תואם ללקוח של החשבונית' }, { status: 403 });
  }

  try {
    const queued = await enqueueProcessing(id, { mimeType: body.mimeType, reuseActiveRun: true });
    if (!queued.ok) {
      return NextResponse.json({ error: queued.error }, { status: queued.httpStatus });
    }
    return NextResponse.json(
      { success: true, status: 'queued', runId: queued.runId, ...(queued.alreadyQueued ? { alreadyQueued: true } : {}) },
      { status: 202 }
    );
  } catch (err) {
    console.error(`[Process Route] ❌ Could not queue invoice ${id}:`, err);
    return NextResponse.json({ error: 'לא ניתן היה להתחיל את העיבוד. יש לנסות שוב' }, { status: 500 });
  }
}
