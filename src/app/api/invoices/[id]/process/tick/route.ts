import { NextResponse } from 'next/server';
import { requireInvoiceAccess } from '@/lib/auth';
import { runProcessingTick, type TickResult } from '@/lib/processingQueue';
import { TICK_HARD_LIMIT_MS, TICK_RESPONSE_MS } from '@/shared/processing';

/**
 * Runs one bounded step of the invoice's queued processing run (OCR batch, boundary detection, one
 * extraction call, or validation + save) and reports where it stands. The review / upload screens
 * call this repeatedly while an invoice shows as processing; the scheduled worker drives the same
 * steps when no screen is open. Safe to call concurrently: a tick that finds the job leased answers
 * `busy`.
 *
 * The step runs inside this request and ends by TICK_RESPONSE_MS (20 s): it starts only if it fits,
 * and its calls time out before then. Nothing is left running after the response (Amplify freezes it,
 * QA round 3). If a step overran anyway, the answer still leaves at TICK_HARD_LIMIT_MS (before
 * Amplify's bare 504); the job's lease then runs out and the next tick redoes that step (counted as
 * a transient interruption).
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const access = await requireInvoiceAccess(id);
  if (!access.ok) return access.response;

  const started = Date.now();
  const work = runProcessingTick(id, { deadline: started + TICK_RESPONSE_MS });
  // Never an unhandled rejection if the answer below leaves before the step ends
  work.catch(() => undefined);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const hardLimit = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), TICK_HARD_LIMIT_MS);
  });
  try {
    const result: TickResult | null = await Promise.race([work, hardLimit]);
    if (result === null) {
      console.warn(`[Process Tick] Step of invoice ${id} overran ${TICK_HARD_LIMIT_MS} ms; answering without it.`);
      return NextResponse.json({ state: 'busy', message: 'העיבוד נמשך - ננסה שוב בעוד רגע' }, { status: 202 });
    }
    return NextResponse.json(result);
  } catch (err) {
    console.error(`[Process Tick] Tick failed for invoice ${id}:`, err);
    return NextResponse.json({ error: 'עדכון מצב העיבוד נכשל. ננסה שוב בעוד רגע' }, { status: 503 });
  } finally {
    if (timer) clearTimeout(timer);
  }
}
