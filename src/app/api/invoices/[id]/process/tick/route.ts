import { NextResponse } from 'next/server';
import { requireInvoiceAccess } from '@/lib/auth';
import { runProcessingTick } from '@/lib/processingQueue';

/**
 * Runs one bounded step of the invoice's queued processing run (OCR batch, boundary detection or
 * extraction) and reports where it stands. The review / upload screens call this repeatedly while
 * an invoice shows as processing, so a run keeps moving even when nothing runs in the background.
 * Safe to call concurrently: a tick that finds the job locked answers `busy`.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const access = await requireInvoiceAccess(id);
  if (!access.ok) return access.response;

  try {
    const result = await runProcessingTick(id);
    return NextResponse.json(result);
  } catch (err) {
    console.error(`[Process Tick] Tick failed for invoice ${id}:`, err);
    return NextResponse.json({ error: 'עדכון מצב העיבוד נכשל. ננסה שוב בעוד רגע' }, { status: 503 });
  }
}
