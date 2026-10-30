import { NextResponse } from 'next/server';
import { safeEqual } from '@/lib/ingestHelpers';
import { driveProcessing, dueJobs, sweepStaleProcessing } from '@/lib/processingQueue';
import { runWorkerPass, workerConfig } from '@/lib/processingWorker';
import { workerSecretCandidates, normalizeWorkerSecret } from '@/shared/workerAuth';

export const dynamic = 'force-dynamic';

/**
 * Scheduled processing worker (an AWS Lambda calls it every minute, and again while `due` > 0, or
 * any cron): queues 'processing' rows that were never queued, marks stuck ones as error, then drives
 * due jobs (any job whose lease is free and whose retry backoff is over) in bounded steps.
 *
 * All of it runs INSIDE this request, within PROCESSING_WORKER_BUDGET_MS (default 23 s, at most
 * 24 s): on Amplify nothing runs after the response (Lambda without waitUntil - after() work is frozen
 * until a later request, QA round 3), and Amplify cuts responses at ~28 s. Steps start only if they
 * fit the budget and their calls / downloads have time limits; should one overrun anyway, the answer
 * still leaves at budget + 3 s (at most 26 s) with what was done, listing the overrunning jobs in
 * `overran` (their leases run out and the next pass redoes those steps). Sizing and limits:
 * src/lib/processingWorker.ts. Safe to call back to back and concurrently: jobs are leased, so two
 * calls never run the same step. Answers 200
 * `{ stuck, enqueued, driven: [{ id, state }], due, ms, overran? }`.
 *
 * Auth: `PROCESSING_WORKER_SECRET` as `X-Ingest-Secret` / `X-Worker-Secret` / `X-Api-Key`,
 * `Authorization: Bearer <secret>` or Basic (secret as password or user). Surrounding whitespace or
 * quotes in the configured value are ignored. 503 when unset. Public in src/lib/routeAccess.ts (no
 * user session), like the ingestion webhooks.
 */
async function handle(request: Request): Promise<NextResponse> {
  const secret = normalizeWorkerSecret(process.env.PROCESSING_WORKER_SECRET);
  if (!secret) {
    return NextResponse.json({ error: 'ה-worker אינו מוגדר' }, { status: 503 });
  }
  const provided = workerSecretCandidates(request.headers);
  if (!provided.some((value) => safeEqual(value, secret))) {
    console.warn(`[Processing Worker] Unauthorized call (${provided.length} credential(s) offered).`);
    return NextResponse.json({ error: 'אין הרשאה' }, { status: 401 });
  }

  try {
    const summary = await runWorkerPass(
      {
        now: () => Date.now(),
        sweep: () => sweepStaleProcessing(null),
        dueJobs: (limit) => dueJobs(limit),
        drive: (id, deadline) => driveProcessing(id, deadline),
      },
      workerConfig()
    );
    if (summary.stuck > 0 || summary.enqueued > 0 || summary.driven.length > 0) {
      console.log(`[Processing Worker] stuck=${summary.stuck} enqueued=${summary.enqueued} driven=${JSON.stringify(summary.driven)} due=${summary.due} in ${summary.ms} ms`);
    }
    return NextResponse.json(summary);
  } catch (err) {
    console.error('[Processing Worker] Run failed:', err);
    return NextResponse.json({ error: 'הרצת ה-worker נכשלה' }, { status: 500 });
  }
}

export const POST = handle;
export const GET = handle;
