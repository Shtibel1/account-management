import { after, NextResponse } from 'next/server';
import { requireInvoiceAccess } from '@/lib/auth';
import { runProcessingTick, type TickResult } from '@/lib/processingQueue';
import { TICK_RESPONSE_MS } from '@/shared/processing';

/**
 * Runs one bounded step of the invoice's queued processing run (OCR batch, boundary detection, one
 * extraction call, or validation + save) and reports where it stands. The review / upload screens
 * call this repeatedly while an invoice shows as processing; the scheduled worker drives the same
 * steps when no screen is open. Safe to call concurrently: a tick that finds the job leased answers
 * `busy`.
 *
 * Never held past TICK_RESPONSE_MS (Amplify cuts responses at ~28 s with a bare 504): a step that
 * runs longer (a slow LLM call) answers 202 `{ state: 'busy' }` and goes on in the background under
 * its renewed lease; its result is stored in the job, and the next tick continues from there.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const access = await requireInvoiceAccess(id);
  if (!access.ok) return access.response;

  const work = runProcessingTick(id);
  // Keeps the step alive after an early answer (and logs a late failure)
  after(() =>
    work.then(
      () => undefined,
      (err) => console.error(`[Process Tick] Background step failed for invoice ${id}:`, err)
    )
  );

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), TICK_RESPONSE_MS);
  });
  try {
    const result: TickResult | null = await Promise.race([work, deadline]);
    if (result === null) {
      return NextResponse.json(
        { state: 'busy', running: true, message: 'העיבוד ממשיך ברקע' },
        { status: 202 }
      );
    }
    return NextResponse.json(result);
  } catch (err) {
    console.error(`[Process Tick] Tick failed for invoice ${id}:`, err);
    return NextResponse.json({ error: 'עדכון מצב העיבוד נכשל. ננסה שוב בעוד רגע' }, { status: 503 });
  } finally {
    if (timer) clearTimeout(timer);
  }
}
