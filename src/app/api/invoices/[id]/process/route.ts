import { after, NextResponse } from 'next/server';
import { requireInvoiceAccess } from '@/lib/auth';
import { driveProcessing, enqueueProcessing } from '@/lib/processingQueue';

/** Background drive right after enqueueing; ticks are short, so this stays well under the limits. */
const AFTER_BUDGET_MS = 20_000;

/**
 * Queues (re)processing of an invoice the user may access and answers 202 at once. The pipeline
 * never runs inside this request (Amplify cuts responses at ~28 s): it runs in short resumable ticks
 * (src/lib/processingQueue.ts) driven by after(), the browser (/process/tick) and the scheduled worker.
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
    const queued = await enqueueProcessing(id, { mimeType: body.mimeType });
    if (!queued.ok) {
      return NextResponse.json({ error: queued.error }, { status: queued.httpStatus });
    }

    // Best-effort head start; if the platform freezes the function after the response, the
    // browser / scheduled worker ticks pick the job up from where it stopped.
    after(async () => {
      try {
        await driveProcessing(id, AFTER_BUDGET_MS);
      } catch (err) {
        console.error(`[Process Route] Background tick failed for invoice ${id}:`, err);
      }
    });

    return NextResponse.json({ success: true, status: 'queued', runId: queued.runId }, { status: 202 });
  } catch (err) {
    console.error(`[Process Route] ❌ Could not queue invoice ${id}:`, err);
    return NextResponse.json({ error: 'לא ניתן היה להתחיל את העיבוד. יש לנסות שוב' }, { status: 500 });
  }
}
