import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { requireInvoiceAccess } from '@/lib/auth';
import { dbErrorResponse, readJsonObject, transitionInvoice } from '@/lib/invoiceTransitions';
import { isClientStorageFileUrl } from '@/lib/ingestHelpers';
import { isMockMode, supabaseUrl } from '@/lib/supabaseConfig';
import { schedulePipeline } from '@/lib/ingest';
import { RETRYABLE_STATUSES, transitionRefusedMessage } from '@/shared/invoiceStatus';
import type { InvoiceStatus } from '@/shared/types';

export const dynamic = 'force-dynamic';

/**
 * "עבד מחדש" for a failed document: moves it from 'error' back to 'processing' (clearing the old
 * error and AI output) and queues the run on the server (`queued: true`), so it doesn't depend on the
 * browser's POST /api/invoices/[id]/process (still accepted: idempotent for the queued run).
 * → 200 { success, status: 'processing', queued } · 400 no usable stored file · 409 not in 'error'
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const access = await requireInvoiceAccess<{ id: string; client_id: string; status: InvoiceStatus; file_url: string | null }>(
    id,
    'id, client_id, status, file_url'
  );
  if (!access.ok) return access.response;
  const invoice = access.value.invoice;

  const parsed = await readJsonObject(request, { optional: true });
  if (!parsed.ok) return parsed.response;

  if (!RETRYABLE_STATUSES.includes(invoice.status)) {
    return NextResponse.json({ error: transitionRefusedMessage('retry', invoice.status), status: invoice.status }, { status: 409 });
  }
  if (
    !invoice.file_url ||
    (!isMockMode() && !isClientStorageFileUrl(invoice.file_url, invoice.client_id, process.env.SUPABASE_URL || supabaseUrl()))
  ) {
    return NextResponse.json({ error: 'לחשבונית אין קובץ שמור שניתן לעבד - יש להעלות אותה מחדש' }, { status: 400 });
  }

  try {
    const outcome = await transitionInvoice(supabase, id, RETRYABLE_STATUSES, {
      status: 'processing',
      error_message: null,
      extracted_data: null,
      validated_data: null,
      ai_confidence: null,
    });
    if (!outcome.ok) {
      if (outcome.reason === 'conflict') {
        return NextResponse.json(
          { error: transitionRefusedMessage('retry', outcome.currentStatus), status: outcome.currentStatus },
          { status: 409 }
        );
      }
      return dbErrorResponse(outcome.error, 'שגיאה בהפעלת העיבוד מחדש');
    }
    const queued = await schedulePipeline(id);
    return NextResponse.json({ success: true, status: 'processing', queued });
  } catch (err) {
    console.error(`[invoices/retry] Failed to reset invoice ${id} for reprocessing:`, err);
    return NextResponse.json({ error: 'שגיאה בהפעלת העיבוד מחדש' }, { status: 500 });
  }
}
