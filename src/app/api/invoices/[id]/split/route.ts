import { randomUUID } from 'crypto';
import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { PDFDocument } from 'pdf-lib';
import { saveInvoiceFileHash, sha256Hex, splitPartHash } from '@/lib/fileHash';
import { checkSplitRequestShape, validateSplitRanges } from '@/shared/documentSplit';
import { requireInvoiceAccess } from '@/lib/auth';
import { isClientStorageFileUrl, sanitizeStorageFilename } from '@/lib/ingestHelpers';
import { isMockMode, supabaseUrl } from '@/lib/supabaseConfig';
import { splitStatusError } from '@/shared/processing';
import { readPdfPageCount, sniffUploadMime } from '@/shared/uploadValidation';
import { enqueueProcessing } from '@/lib/processingQueue';
import { downloadInvoiceFile, redactUrlForLog, storedFileUrlFor } from '@/lib/invoiceFiles';

const RAW_BUCKET = 'raw-invoices';

const MSG_SPLIT_FAILED = 'פיצול הקובץ נכשל. יש לנסות שוב';

interface SplitInvoiceRow {
  id: string;
  client_id: string;
  status: string;
  file_url: string | null;
  file_name: string | null;
  file_hash?: string | null;
  processing_run_id?: string | null;
  [key: string]: unknown;
}

function badRequest(error: string, status = 400) {
  return NextResponse.json({ error }, { status });
}

/** Releases the split claim when something failed after it (back to the status it had). */
async function releaseClaim(id: string, claimToken: string, previousStatus: string): Promise<void> {
  const { error } = await supabase
    .from('invoices')
    .update({ status: previousStatus, processing_stage: null, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('processing_run_id', claimToken);
  if (error) console.error(`[Split API] Could not release the split claim of invoice ${id}:`, error);
}

/** Lineage columns in a separate best-effort update (a missing column must not fail the split). */
async function saveLineage(invoiceId: string, lineage: Record<string, unknown>): Promise<void> {
  try {
    const { error } = await supabase.from('invoices').update(lineage).eq('id', invoiceId);
    if (error) throw error;
  } catch (err) {
    console.error(`[Split API] Could not save split lineage of invoice ${invoiceId}:`, err);
  }
}

/**
 * Splits a multi-page PDF invoice into parts (findings #20, #21, #42, #43, #44):
 * - only from 'review' / 'error' (never while processing, never approved / exported);
 * - the request shape is checked before anything is downloaded; Hebrew 400s for every bad input;
 * - the invoice is claimed atomically (status + run token + file as read), so two concurrent splits
 *   can't both succeed and an in-flight pipeline run can no longer write onto part 1;
 * - the original file stays in storage and is referenced from every part (original_file_*);
 * - part fingerprints are derived from the source hash + page range (deterministic);
 * - the parts are queued for processing on the server (no browser /process calls needed).
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const access = await requireInvoiceAccess<SplitInvoiceRow>(id, '*');
  if (!access.ok) return access.response;
  const invoice = access.value.invoice;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest('בקשה לא תקינה');
  }
  const requestedSplits = body && typeof body === 'object' ? (body as { splits?: unknown }).splits : undefined;
  const shape = checkSplitRequestShape(requestedSplits);
  if (!shape.ok) return badRequest(shape.error);

  const statusError = splitStatusError(invoice.status);
  if (statusError) return badRequest(statusError, 409);

  if (!invoice.file_url) return badRequest('לחשבונית אין קובץ שמור ולכן לא ניתן לפצל אותה');
  const fileName = invoice.file_name || 'invoice.pdf';
  if (/\.(jpe?g|png|webp|gif|tiff?|heic|heif)$/i.test(fileName)) {
    return badRequest('ניתן לפצל רק קבצי PDF');
  }
  // file_url is user-editable: only our own storage URLs for this client are fetched
  if (!isMockMode() && !isClientStorageFileUrl(invoice.file_url, invoice.client_id, process.env.SUPABASE_URL || supabaseUrl())) {
    console.error(`[Split API] Refusing to fetch untrusted file URL for invoice ${id}`);
    return badRequest('קובץ החשבונית אינו קובץ אחסון של הלקוח, ולכן לא ניתן לפצל אותו');
  }

  // 1. Download + parse + validate the ranges against the real page count (read-only so far)
  // Service-role Storage read of the object (file_url is a storage reference, not a link - QA #31)
  let fileBuffer: Buffer;
  try {
    const downloaded = await downloadInvoiceFile(invoice.file_url, invoice.client_id);
    if (!downloaded) throw new Error(`Storage download of ${redactUrlForLog(invoice.file_url)} failed`);
    fileBuffer = downloaded;
  } catch (err) {
    console.error(`[Split API] Download of the original file of invoice ${id} failed:`, err);
    return NextResponse.json({ error: 'לא ניתן היה לקרוא את הקובץ מהאחסון. יש לנסות שוב' }, { status: 502 });
  }
  if (sniffUploadMime(fileBuffer) !== 'application/pdf') {
    return badRequest('ניתן לפצל רק קבצי PDF');
  }
  let originalDoc: PDFDocument;
  try {
    originalDoc = await PDFDocument.load(fileBuffer);
  } catch (err) {
    console.error(`[Split API] Could not parse the PDF of invoice ${id}:`, err);
    const encrypted = err instanceof Error && /encrypt/i.test(err.message);
    return badRequest(encrypted ? 'הקובץ מוגן בסיסמה ולכן לא ניתן לפצל אותו' : 'קובץ ה-PDF פגום ולא ניתן לפצל אותו');
  }

  // Ranges must be 1-based, contiguous, non-overlapping and cover every page of this file
  // pdf-lib loads some damaged files and fails only on their page tree (QA round 4)
  const originalPages = readPdfPageCount(originalDoc);
  if (originalPages === null) return badRequest('קובץ ה-PDF פגום ולא ניתן לפצל אותו');
  const rangeCheck = validateSplitRanges(requestedSplits, originalPages);
  if (!rangeCheck.ok) return badRequest(rangeCheck.error);
  if (rangeCheck.ranges.length < 2) return badRequest('נדרשים לפחות שני חלקים כדי לפצל את המסמך');
  const splits = rangeCheck.ranges.map((r) => ({ startPage: r.start_page, endPage: r.end_page }));

  // 2. Atomic claim: only the request that still sees the row exactly as read gets it
  const claimToken = randomUUID();
  let claim = supabase
    .from('invoices')
    .update({
      status: 'processing',
      processing_stage: 'splitting',
      processing_run_id: claimToken,
      // A fresh start time: the stuck-run check (tick / sweeper) must not judge this claim by the
      // start time of an earlier processing run (> MAX_RUN_MS ago) and fail it mid-split
      processing_started_at: new Date().toISOString(),
      processing_progress: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('status', invoice.status)
    .eq('file_url', invoice.file_url);
  claim = invoice.processing_run_id ? claim.eq('processing_run_id', invoice.processing_run_id) : claim.is('processing_run_id', null);
  const { data: claimed, error: claimErr } = await claim.select('id');
  if (claimErr) {
    console.error(`[Split API] Claim of invoice ${id} failed:`, claimErr);
    return NextResponse.json({ error: MSG_SPLIT_FAILED }, { status: 500 });
  }
  if (!Array.isArray(claimed) || claimed.length === 0) {
    return badRequest('החשבונית כבר פוצלה או נמצאת בעיבוד. יש לרענן את העמוד', 409);
  }

  const lastDot = fileName.lastIndexOf('.');
  const ext = lastDot !== -1 ? fileName.substring(lastDot) : '.pdf';
  const nameWithoutExt = lastDot !== -1 ? fileName.substring(0, lastDot) : fileName;
  const sanitizedBase = sanitizeStorageFilename(nameWithoutExt).replace(/\.[^.]*$/, '') || 'invoice';
  const sourceHash = invoice.file_hash || sha256Hex(fileBuffer);
  const lineageBase = {
    original_file_url: invoice.file_url,
    original_file_name: fileName,
    original_file_hash: sourceHash,
  };

  const uploadedPaths: string[] = [];
  const results: { id: string; fileUrl: string; mimeType: string }[] = [];
  try {
    // 3. Build and store every part first; rows change only once all parts are stored
    const stamp = Date.now();
    const parts: { startPage: number; endPage: number; fileUrl: string; fileName: string; hash: string }[] = [];
    for (let idx = 0; idx < splits.length; idx++) {
      const { startPage, endPage } = splits[idx];
      const newDoc = await PDFDocument.create({ updateMetadata: false });
      const pagesToCopy: number[] = [];
      for (let p = startPage - 1; p <= endPage - 1; p++) pagesToCopy.push(p);
      const copiedPages = await newDoc.copyPages(originalDoc, pagesToCopy);
      copiedPages.forEach((page) => newDoc.addPage(page));
      const splitBuffer = Buffer.from(await newDoc.save({ updateFieldAppearances: false }));

      const uploadPath = `${invoice.client_id}/${stamp}_${sanitizedBase}_part_${idx + 1}.pdf`;
      const { data: uploadData, error: uploadErr } = await supabase.storage
        .from(RAW_BUCKET)
        .upload(uploadPath, splitBuffer, { contentType: 'application/pdf', upsert: true });
      if (uploadErr || !uploadData) throw new Error(`Upload of part ${idx + 1} failed: ${uploadErr?.message}`);
      uploadedPaths.push(uploadPath);


      parts.push({
        startPage,
        endPage,
        // Stored as a storage reference, not a bearer link (QA #31)
        fileUrl: storedFileUrlFor(uploadPath),
        fileName: `${nameWithoutExt}_חלק_${idx + 1}${ext}`,
        hash: splitPartHash(sourceHash, startPage, endPage),
      });
    }

    // 4. The invoice itself becomes part 1 (only while it still holds this split's claim)
    const first = parts[0];
    const { data: updated, error: updateErr } = await supabase
      .from('invoices')
      .update({
        file_url: first.fileUrl,
        file_name: first.fileName,
        status: 'processing',
        processing_stage: 'queued',
        extracted_data: null,
        validated_data: null,
        ai_confidence: null,
        error_message: null,
        // the new content was never reviewed: it must not count as a human-reviewed example
        reviewed_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('processing_run_id', claimToken)
      .select('id');
    if (updateErr) throw new Error(`Update of the original invoice failed: ${updateErr.message}`);
    if (!Array.isArray(updated) || updated.length === 0) throw new Error('The split claim was lost');
    await saveInvoiceFileHash(supabase, id, first.hash);
    await saveLineage(id, { ...lineageBase, split_start_page: first.startPage, split_end_page: first.endPage });
    results.push({ id, fileUrl: first.fileUrl, mimeType: 'application/pdf' });

    // 5. One new invoice per further part
    for (let idx = 1; idx < parts.length; idx++) {
      const part = parts[idx];
      const { data: newInvoice, error: insertErr } = await supabase
        .from('invoices')
        .insert({
          client_id: invoice.client_id,
          file_url: part.fileUrl,
          file_name: part.fileName,
          status: 'processing',
        })
        .select()
        .single();
      if (insertErr || !newInvoice) {
        // Part 1 is already in place: log, keep going with the parts that can be created
        console.error(`[Split API] Insert of part ${idx + 1} of invoice ${id} failed:`, insertErr);
        continue;
      }
      await saveInvoiceFileHash(supabase, newInvoice.id, part.hash);
      await saveLineage(newInvoice.id, {
        ...lineageBase,
        split_parent_id: id,
        split_start_page: part.startPage,
        split_end_page: part.endPage,
      });
      results.push({ id: newInvoice.id, fileUrl: part.fileUrl, mimeType: 'application/pdf' });
    }
  } catch (err) {
    console.error(`[Split API] Error during splitting of invoice ${id}:`, err);
    if (results.length === 0) {
      await releaseClaim(id, claimToken, invoice.status);
      if (uploadedPaths.length > 0) {
        await supabase.storage.from(RAW_BUCKET).remove(uploadedPaths).catch(() => undefined);
      }
      return NextResponse.json({ error: MSG_SPLIT_FAILED }, { status: 500 });
    }
  }

  // 6. Queue every part on the server (in parallel: each part is its own row, and a 20-part split
  // must stay within the response limit). The parts are processed by the review screens' ticks and
  // the scheduled worker - nothing is left running after this response (Amplify freezes it, QA round 3).
  const queuedIds: string[] = [];
  const queuedResults = await Promise.all(
    results.map((part) =>
      enqueueProcessing(part.id, { mimeType: 'application/pdf', ...(part.id === id ? { claimToken } : {}) }).catch((err) => {
        console.error(`[Split API] Queueing part ${part.id} crashed:`, err);
        return { ok: false as const, httpStatus: 500 as const, error: String(err) };
      })
    )
  );
  queuedResults.forEach((queued, idx) => {
    if (queued.ok) queuedIds.push(results[idx].id);
    else console.error(`[Split API] Could not queue part ${results[idx].id}: ${queued.error}`);
  });
  console.log(`[Split API] Split of invoice ${id} complete: ${results.length} parts, ${queuedIds.length} queued.`);
  return NextResponse.json({
    success: true,
    invoices: results,
    ...(results.length < splits.length ? { warning: `נוצרו ${results.length} מתוך ${splits.length} חלקים` } : {}),
  });
}
