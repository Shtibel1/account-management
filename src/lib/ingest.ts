import { after } from 'next/server';
import { supabase } from '@/lib/supabase';
import { runOrchestrationPipeline } from '@/agents/supervisor';
import { buildStoragePath, MAX_DOCUMENT_BYTES } from '@/lib/ingestHelpers';
import type { InvoiceSource } from '@/shared/types';

/**
 * Single server-side entry point for every ingestion channel (upload, email, WhatsApp):
 * store the raw file in the raw-invoices bucket, create the invoice row, start the pipeline.
 */

const RAW_BUCKET = 'raw-invoices';
/** Signed read URLs live for a year, same as the original upload flow. */
const SIGNED_URL_TTL_SECONDS = 60 * 60 * 24 * 365;

export interface StoredDocument {
  clientId: string;
  filePath: string;
  fileName: string;
  source?: InvoiceSource;
  /** Sender address / phone (email, WhatsApp). */
  sender?: string | null;
  /** Provider message reference used for de-duplication of webhook retries. */
  sourceRef?: string | null;
}

export type RegisterResult =
  | { fileName: string; status: 'success'; id: string; fileUrl: string }
  | { fileName: string; status: 'error'; id?: string; error: string };

interface DbError {
  code?: string;
  message: string;
}

/** True when PostgREST rejected a write because a column doesn't exist yet (migration not applied). */
function isMissingColumnError(err: DbError | null): boolean {
  if (!err) return false;
  return err.code === 'PGRST204' || err.code === '42703' || /column .* does not exist|Could not find the '.*' column/i.test(err.message);
}

/**
 * Inserts an invoice row. Channel columns (source, source_sender, source_ref) are only sent for
 * non-upload sources (upload relies on the column default), and are dropped with a warning when
 * the ingestion_channels migration hasn't been applied yet.
 */
async function insertInvoiceRow(
  row: Record<string, unknown>,
  doc: StoredDocument
): Promise<{ data: { id: string } | null; error: DbError | null }> {
  const channelColumns: Record<string, unknown> = {};
  if (doc.source && doc.source !== 'upload') {
    channelColumns.source = doc.source;
    if (doc.sender) channelColumns.source_sender = doc.sender;
    if (doc.sourceRef) channelColumns.source_ref = doc.sourceRef;
  }

  const first = await supabase.from('invoices').insert({ ...row, ...channelColumns }).select().single();
  if (!first.error || Object.keys(channelColumns).length === 0 || !isMissingColumnError(first.error)) {
    return { data: first.data, error: first.error };
  }

  console.warn('[Ingest] invoices.source columns missing - apply the ingestion_channels migration. Inserting without them.');
  const retry = await supabase.from('invoices').insert(row).select().single();
  return { data: retry.data, error: retry.error };
}

/**
 * Creates the invoice row for a file already in the raw-invoices bucket (signs a read URL first).
 * Does NOT start the pipeline - the browser upload flow triggers /api/invoices/[id]/process itself.
 */
export async function registerStoredDocument(doc: StoredDocument): Promise<RegisterResult> {
  const { clientId, filePath, fileName } = doc;

  // 1. Generate signed URL valid for 1 year
  const { data: signedData, error: signErr } = await supabase.storage
    .from(RAW_BUCKET)
    .createSignedUrl(filePath, SIGNED_URL_TTL_SECONDS);

  if (signErr || !signedData?.signedUrl) {
    console.error('Signed URL generation failed:', signErr);
    const errMsg = `Signed URL generation failed: ${signErr?.message || 'Unknown error'}`;

    // Record failure in database
    const { data: invoice, error: dbErr } = await insertInvoiceRow(
      { client_id: clientId, file_url: '', file_name: fileName, status: 'error', error_message: errMsg },
      // No source_ref on failure rows, so a provider retry isn't mistaken for a duplicate.
      { ...doc, sourceRef: null }
    );

    return {
      fileName,
      status: 'error',
      id: invoice?.id,
      error: errMsg + (dbErr ? `. Also DB insert failed: ${dbErr.message}` : ''),
    };
  }

  const fileUrl = signedData.signedUrl;

  // 2. Insert Invoice record in database
  const { data: invoice, error: dbErr } = await insertInvoiceRow(
    { client_id: clientId, file_url: fileUrl, file_name: fileName, status: 'processing' },
    doc
  );

  if (dbErr || !invoice) {
    console.error('Database insertion failed:', dbErr);
    return { fileName, status: 'error', error: `Database insertion failed: ${dbErr?.message ?? 'no row returned'}` };
  }

  return { fileName, status: 'success', id: invoice.id, fileUrl };
}

/**
 * Runs the pipeline after the HTTP response is sent (next/server `after`), so webhooks answer
 * within the provider's timeout. Outside a request scope it falls back to fire-and-forget.
 */
export function schedulePipeline(invoiceId: string, fileUrl: string, mimeType: string, clientId: string): void {
  const task = async () => {
    try {
      await runOrchestrationPipeline(invoiceId, fileUrl, mimeType, clientId);
    } catch (err) {
      // runOrchestrationPipeline already marks the invoice as 'error'.
      console.error(`[Ingest] Pipeline failed for invoice ${invoiceId}:`, err);
    }
  };

  try {
    after(task);
  } catch (err) {
    console.warn('[Ingest] after() unavailable outside a request scope, running pipeline detached:', err);
    void task();
  }
}

export interface IngestDocumentInput {
  clientId: string;
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
  source: InvoiceSource;
  sender?: string | null;
  sourceRef?: string | null;
}

/** Stores the bytes, creates the invoice row and schedules the pipeline - like a browser upload. */
export async function ingestDocument(input: IngestDocumentInput): Promise<RegisterResult> {
  const { clientId, fileName, mimeType, bytes } = input;

  if (bytes.byteLength === 0) {
    return { fileName, status: 'error', error: 'Empty file' };
  }
  if (bytes.byteLength > MAX_DOCUMENT_BYTES) {
    return { fileName, status: 'error', error: `File exceeds ${MAX_DOCUMENT_BYTES / 1024 / 1024}MB limit` };
  }

  const filePath = buildStoragePath(clientId, fileName);
  const { error: uploadErr } = await supabase.storage
    .from(RAW_BUCKET)
    .upload(filePath, Buffer.from(bytes), { contentType: mimeType, upsert: false });

  if (uploadErr) {
    console.error(`[Ingest] Storage upload failed for ${fileName}:`, uploadErr);
    return { fileName, status: 'error', error: `Storage upload failed: ${uploadErr.message}` };
  }

  const result = await registerStoredDocument({
    clientId,
    filePath,
    fileName,
    source: input.source,
    sender: input.sender,
    sourceRef: input.sourceRef,
  });

  if (result.status === 'success') {
    schedulePipeline(result.id, result.fileUrl, mimeType, clientId);
  }
  return result;
}

/**
 * True when an invoice with this provider reference already exists (webhook retried).
 * Fails open (returns false) when the source_ref column is missing.
 */
export async function isAlreadyIngested(sourceRef: string): Promise<boolean> {
  const { data, error } = await supabase.from('invoices').select('id').eq('source_ref', sourceRef);
  if (error) {
    console.warn(`[Ingest] De-duplication lookup failed (${error.message}); ingesting anyway.`);
    return false;
  }
  return Array.isArray(data) && data.length > 0;
}
