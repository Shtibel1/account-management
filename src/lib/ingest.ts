import { after } from 'next/server';
import { supabase } from '@/lib/supabase';
import { driveProcessing, enqueueProcessing } from '@/lib/processingQueue';
import { buildStoragePath, MAX_DOCUMENT_BYTES } from '@/lib/ingestHelpers';
import { hashStoredFile, saveInvoiceFileHash, sha256Hex } from '@/lib/fileHash';
import type { InvoiceSource } from '@/shared/types';
import { checkStoredBytes } from '@/shared/uploadValidation';

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
  /** SHA-256 of the bytes when the caller already has them; otherwise the stored file is downloaded and hashed. */
  fileHash?: string | null;
}

export type RegisterResult =
  | { fileName: string; status: 'success'; id: string; fileUrl: string }
  | { fileName: string; status: 'error'; id?: string; error: string; duplicate?: boolean };

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

/** The stored object's bytes, or null when they can't be read (the local mock storage has no download). */
async function downloadStoredFile(filePath: string): Promise<Buffer | null> {
  try {
    const storage = supabase.storage.from(RAW_BUCKET);
    if (typeof storage.download !== 'function') return null;
    const { data, error } = await storage.download(filePath);
    if (error || !data) throw error ?? new Error('Empty download');
    return Buffer.from(await data.arrayBuffer());
  } catch (err) {
    console.error(`[Ingest] Could not read stored upload ${filePath}:`, err);
    return null;
  }
}

async function removeStoredFile(filePath: string): Promise<void> {
  try {
    await supabase.storage.from(RAW_BUCKET).remove([filePath]);
  } catch (err) {
    console.warn(`[Ingest] Could not remove rejected upload ${filePath}:`, err);
  }
}

/**
 * Creates the invoice row for a file already in the raw-invoices bucket (signs a read URL first).
 * Does NOT start the pipeline - the browser upload flow triggers /api/invoices/[id]/process itself.
 */
export async function registerStoredDocument(doc: StoredDocument): Promise<RegisterResult> {
  const { clientId, filePath, fileName } = doc;

  // Browser uploads go straight to Storage, so the server checks the stored bytes here:
  // size (20 MB), not empty, and a real PDF / JPG / PNG / WEBP by magic bytes. Rejected files
  // get no invoice row and never reach OCR. (Email / WhatsApp bytes are checked before storing.)
  let precomputedHash: string | null | undefined = doc.fileHash;
  if (doc.fileHash === undefined) {
    const stored = await downloadStoredFile(filePath);
    if (stored) {
      const check = checkStoredBytes(stored);
      if (!check.ok) {
        console.warn(`[Ingest] Rejected stored upload ${filePath}: ${check.error}`);
        await removeStoredFile(filePath);
        return { fileName, status: 'error', error: check.error };
      }
      precomputedHash = sha256Hex(stored);
    } else {
      precomputedHash = undefined;
    }
  }

  // 1. Generate signed URL valid for 1 year
  const { data: signedData, error: signErr } = await supabase.storage
    .from(RAW_BUCKET)
    .createSignedUrl(filePath, SIGNED_URL_TTL_SECONDS);

  if (signErr || !signedData?.signedUrl) {
    console.error('Signed URL generation failed:', signErr);
    const errMsg = 'שמירת הקובץ נכשלה - יש להעלות אותו שוב';

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
      error: errMsg,
    };
  }

  const fileUrl = signedData.signedUrl;

  // 2. Insert Invoice record in database
  const { data: invoice, error: dbErr } = await insertInvoiceRow(
    { client_id: clientId, file_url: fileUrl, file_name: fileName, status: 'processing' },
    doc
  );

  if (dbErr?.code === '23505' && doc.sourceRef) {
    // A concurrent webhook retry won the race on invoices_source_ref_key - the document is already in.
    console.warn(`[Ingest] Duplicate source_ref ${doc.sourceRef}, ignoring.`);
    try {
      await supabase.storage.from(RAW_BUCKET).remove([filePath]); // drop the orphaned copy
    } catch (err) {
      console.warn(`[Ingest] Could not remove duplicate file ${filePath}:`, err);
    }
    return { fileName, status: 'error', error: 'Duplicate document', duplicate: true };
  }

  if (dbErr || !invoice) {
    console.error('Database insertion failed:', dbErr);
    return { fileName, status: 'error', error: 'רישום החשבונית נכשל - יש לנסות שוב' };
  }

  // 3. Fingerprint the stored bytes for exact-duplicate detection (every channel goes through here).
  // Awaited so the hash is in place before the pipeline runs; failures only skip the same-file check.
  const fileHash = precomputedHash !== undefined ? precomputedHash : await hashStoredFile(supabase, RAW_BUCKET, filePath);
  if (fileHash) await saveInvoiceFileHash(supabase, invoice.id, fileHash);

  return { fileName, status: 'success', id: invoice.id, fileUrl };
}

/**
 * Queues the pipeline (src/lib/processingQueue.ts) and gives it a head start after the HTTP
 * response is sent (next/server `after`), so webhooks answer within the provider's timeout.
 * If the platform stops the function early, the scheduled worker / review screen continue the run.
 */
export async function schedulePipeline(invoiceId: string, mimeType: string): Promise<void> {
  // Enqueued before answering, so the job exists even if the background head start never runs
  const queued = await enqueueProcessing(invoiceId, { mimeType });
  if (!queued.ok) {
    console.error(`[Ingest] Could not queue invoice ${invoiceId}: ${queued.error}`);
    return;
  }
  const task = async () => {
    try {
      await driveProcessing(invoiceId, 20_000);
    } catch (err) {
      console.error(`[Ingest] Pipeline tick failed for invoice ${invoiceId}:`, err);
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
    return { fileName, status: 'error', error: 'הקובץ ריק' };
  }
  if (bytes.byteLength > MAX_DOCUMENT_BYTES) {
    return { fileName, status: 'error', error: `הקובץ גדול מ-${MAX_DOCUMENT_BYTES / 1024 / 1024}MB` };
  }

  const filePath = buildStoragePath(clientId, fileName);
  const { error: uploadErr } = await supabase.storage
    .from(RAW_BUCKET)
    .upload(filePath, Buffer.from(bytes), { contentType: mimeType, upsert: false });

  if (uploadErr) {
    console.error(`[Ingest] Storage upload failed for ${fileName}:`, uploadErr);
    return { fileName, status: 'error', error: 'שמירת הקובץ נכשלה - יש לשלוח אותו שוב' };
  }

  const result = await registerStoredDocument({
    clientId,
    filePath,
    fileName,
    source: input.source,
    sender: input.sender,
    sourceRef: input.sourceRef,
    fileHash: sha256Hex(bytes),
  });

  if (result.status === 'success') {
    await schedulePipeline(result.id, mimeType);
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
