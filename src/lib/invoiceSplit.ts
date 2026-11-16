import { PDFDocument } from 'pdf-lib';
import { supabase } from '@/lib/supabase';
import { RAW_BUCKET, storedFileUrlFor } from '@/lib/invoiceFiles';
import { sanitizeStorageFilename } from '@/lib/ingestHelpers';
import type { PageRange } from '@/shared/documentSplit';

// Building and storing the parts of a split PDF: shared by the manual split route and the processing
// queue's automatic split (src/lib/processingQueue.ts).

/** One PDF per range (1-based, inclusive), copied page by page from the original. */
export async function buildSplitPdfs(originalDoc: PDFDocument, ranges: PageRange[]): Promise<Buffer[]> {
  const out: Buffer[] = [];
  for (const { start_page, end_page } of ranges) {
    const newDoc = await PDFDocument.create({ updateMetadata: false });
    const pagesToCopy: number[] = [];
    for (let p = start_page - 1; p <= end_page - 1; p++) pagesToCopy.push(p);
    const copiedPages = await newDoc.copyPages(originalDoc, pagesToCopy);
    copiedPages.forEach((page) => newDoc.addPage(page));
    out.push(Buffer.from(await newDoc.save({ updateFieldAppearances: false })));
  }
  return out;
}

/** "invoice.pdf" -> { base: 'invoice', ext: '.pdf' } and the storage-safe base name. */
export function splitFileNames(fileName: string | null | undefined): { nameWithoutExt: string; ext: string; storageBase: string } {
  const name = fileName || 'invoice.pdf';
  const lastDot = name.lastIndexOf('.');
  const ext = lastDot !== -1 ? name.substring(lastDot) : '.pdf';
  const nameWithoutExt = lastDot !== -1 ? name.substring(0, lastDot) : name;
  const storageBase = sanitizeStorageFilename(nameWithoutExt).replace(/\.[^.]*$/, '') || 'invoice';
  return { nameWithoutExt, ext, storageBase };
}

/** File name of part `index` (0-based) of a split: "<name>_חלק_<n><ext>". */
export function splitPartFileName(fileName: string | null | undefined, index: number): string {
  const { nameWithoutExt, ext } = splitFileNames(fileName);
  return `${nameWithoutExt}_חלק_${index + 1}${ext}`;
}

export interface StoredSplitPart extends PageRange {
  /** Storage reference (not a link, QA #31). */
  fileUrl: string;
  objectPath: string;
}

/**
 * Splits a PDF and uploads every part to `<clientId>/<tag>_<name>_part_<n>.pdf` (upsert: the same
 * tag gives the same paths, so a retried automatic split overwrites instead of piling up copies).
 * Throws when the PDF can't be parsed or an upload fails; uploaded parts are removed then.
 */
export async function splitPdfIntoStoredParts(
  file: Buffer,
  ranges: PageRange[],
  target: { clientId: string; fileName: string | null; tag: string }
): Promise<StoredSplitPart[]> {
  const doc = await PDFDocument.load(file, { ignoreEncryption: true });
  const buffers = await buildSplitPdfs(doc, ranges);
  const { storageBase } = splitFileNames(target.fileName);
  const paths = ranges.map((_, idx) => `${target.clientId}/${target.tag}_${storageBase}_part_${idx + 1}.pdf`);
  const results = await Promise.all(
    buffers.map((buf, idx) =>
      supabase.storage.from(RAW_BUCKET).upload(paths[idx], buf, { contentType: 'application/pdf', upsert: true })
    )
  );
  const failed = results.findIndex((r) => r.error || !r.data);
  if (failed !== -1) {
    await supabase.storage.from(RAW_BUCKET).remove(paths).catch(() => undefined);
    throw new Error(`Upload of split part ${failed + 1} failed: ${results[failed].error?.message ?? 'no data'}`);
  }
  return ranges.map((r, idx) => ({ ...r, objectPath: paths[idx], fileUrl: storedFileUrlFor(paths[idx]) }));
}
