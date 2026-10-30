import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { runOrchestrationPipeline } from '@/agents/supervisor';
import { requireInvoiceAccess } from '@/lib/auth';

const SUPPORTED_MIME = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/gif', 'image/tiff']);

/**
 * Runs the pipeline for an invoice the user may access. The file URL and the client (tenant) come
 * from the stored invoice row - body values are not trusted. `mimeType` from the body is only a
 * hint for the file type; `fileUrl` / `tenantId` in the body are ignored (kept for older clients)
 * and a tenantId that doesn't match the invoice's client is rejected.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const access = await requireInvoiceAccess<{ id: string; client_id: string; file_url: string | null; file_name: string | null }>(
    id,
    'id, client_id, file_url, file_name'
  );
  if (!access.ok) return access.response;
  const invoice = access.value.invoice;

  try {
    const body = ((await request.json().catch(() => ({}))) ?? {}) as { mimeType?: unknown; tenantId?: unknown };

    if (body.tenantId !== undefined && body.tenantId !== invoice.client_id) {
      return NextResponse.json({ error: 'tenantId does not match the invoice client' }, { status: 403 });
    }

    const mimeType =
      typeof body.mimeType === 'string' && SUPPORTED_MIME.has(body.mimeType)
        ? body.mimeType
        : (invoice.file_name ?? '').toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'image/jpeg';

    if (!invoice.file_url) {
      console.error(`[Process Route] ❌ Invoice ${id} has no stored file URL`);
      await supabase.from('invoices').update({
        status: 'error',
        error_message: 'Invoice has no stored file to process',
        updated_at: new Date().toISOString(),
      }).eq('id', id);
      return NextResponse.json({ error: 'Invoice has no stored file' }, { status: 400 });
    }

    console.log(`[Process Route] 🚀 Starting synchronous pipeline execution for invoice ${id}`);

    // Await the pipeline run to completion (or pause at manual review)
    await runOrchestrationPipeline(id, invoice.file_url, mimeType, invoice.client_id);

    console.log(`[Process Route] ✅ Synchronous pipeline finished/paused for invoice ${id}`);
    return NextResponse.json({ success: true, status: 'completed' });
  } catch (err) {
    console.error(`[Process Route] ❌ Pipeline execution failed for invoice ${id}:`, err);

    try {
      await supabase.from('invoices').update({
        status: 'error',
        error_message: err instanceof Error ? err.message : String(err),
        updated_at: new Date().toISOString(),
      }).eq('id', id);
    } catch (dbErr) {
      console.error(`[Process Route] ❌ Failed to update database status to error for invoice ${id}:`, dbErr);
    }

    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
