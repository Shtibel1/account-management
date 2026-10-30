import { after, NextResponse } from 'next/server';
import { safeEqual } from '@/lib/ingestHelpers';
import { driveProcessing, dueJobIds, sweepStaleProcessing } from '@/lib/processingQueue';
import { workerSecretCandidates, normalizeWorkerSecret } from '@/shared/workerAuth';

/** Background work per call: each job's steps are bounded (one LLM call / ~14 s of OCR per tick). */
const WORKER_DRIVE_BUDGET_MS = 15_000;
/** Jobs driven in parallel per call (the next call, a minute later, takes the next ones). */
const WORKER_MAX_JOBS = 4;

async function runWorker(): Promise<void> {
  const started = Date.now();
  try {
    const stuck = await sweepStaleProcessing(null);
    const ids = await dueJobIds(WORKER_MAX_JOBS);
    const left = Math.max(5_000, WORKER_DRIVE_BUDGET_MS - (Date.now() - started));
    const results = await Promise.all(
      ids.map((id) =>
        driveProcessing(id, left).then(
          (r) => ({ id, state: r.state }),
          (err) => {
            console.error(`[Processing Worker] Drive failed for invoice ${id}:`, err);
            return { id, state: 'error' };
          }
        )
      )
    );
    if (stuck.length > 0 || results.length > 0) {
      console.log(`[Processing Worker] stuck=${stuck.length} driven=${JSON.stringify(results)} in ${Date.now() - started} ms`);
    }
  } catch (err) {
    console.error('[Processing Worker] Run failed:', err);
  }
}

/**
 * Scheduled processing worker (EventBridge Scheduler / API destination, or any cron, every minute):
 * marks stuck 'processing' invoices as error, then drives queued jobs (resumes any job whose lease
 * is free). EventBridge API destinations give up after 5 s, so the call is answered at once (202)
 * and the work runs after the response (next/server after()), in bounded steps.
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

  after(runWorker);
  return NextResponse.json({ accepted: true }, { status: 202 });
}

export const POST = handle;
export const GET = handle;
