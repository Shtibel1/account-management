import { NextResponse } from 'next/server';
import { extractIngestSecret, safeEqual } from '@/lib/ingestHelpers';
import { dueJobIds, runProcessingTick, sweepStaleProcessing } from '@/lib/processingQueue';

/** Stays well under the ~28 s Amplify response limit. */
const WORKER_BUDGET_MS = 18_000;

/**
 * Scheduled processing worker (e.g. EventBridge Scheduler / any cron, every minute):
 * marks stuck 'processing' invoices as error, then ticks queued jobs within a time budget.
 * Auth: `PROCESSING_WORKER_SECRET` as `X-Ingest-Secret` or `Authorization: Bearer`. 503 when unset.
 * Public in src/lib/routeAccess.ts (no user session), like the ingestion webhooks.
 */
async function handle(request: Request): Promise<NextResponse> {
  const secret = process.env.PROCESSING_WORKER_SECRET;
  if (!secret) {
    return NextResponse.json({ error: 'ה-worker אינו מוגדר' }, { status: 503 });
  }
  const provided = extractIngestSecret(request.headers);
  if (!provided || !safeEqual(provided, secret)) {
    return NextResponse.json({ error: 'אין הרשאה' }, { status: 401 });
  }

  const started = Date.now();
  try {
    const stuck = await sweepStaleProcessing(null);
    const ticked: { id: string; state: string }[] = [];
    for (const id of await dueJobIds(10)) {
      if (Date.now() - started > WORKER_BUDGET_MS) break;
      const result = await runProcessingTick(id);
      ticked.push({ id, state: result.state });
    }
    return NextResponse.json({ stuck: stuck.length, ticked });
  } catch (err) {
    console.error('[Processing Worker] Run failed:', err);
    return NextResponse.json({ error: 'הרצת ה-worker נכשלה' }, { status: 500 });
  }
}

export const POST = handle;
export const GET = handle;
