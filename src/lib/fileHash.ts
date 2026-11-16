import { createHash } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

// File fingerprints for exact-duplicate detection (invoices.file_hash).

/** SHA-256 of the file bytes, lowercase hex. */
export function sha256Hex(bytes: Buffer | Uint8Array | ArrayBuffer): string {
  const buf = bytes instanceof ArrayBuffer ? Buffer.from(bytes) : Buffer.from(bytes);
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Hashes a file already uploaded to Storage (the browser uploads straight to a signed URL,
 * so the server never sees the bytes otherwise). Returns null when it can't be read:
 * a missing fingerprint must never block an upload.
 */
export async function hashStoredFile(
  db: SupabaseClient,
  bucket: string,
  filePath: string
): Promise<string | null> {
  try {
    const storage = db.storage.from(bucket);
    // The local mock storage has no download(); duplicate-by-file is simply skipped there
    if (typeof storage.download !== 'function') return null;
    const { data, error } = await storage.download(filePath);
    if (error || !data) throw error ?? new Error('Empty download');
    return sha256Hex(await data.arrayBuffer());
  } catch (err) {
    console.error(`[fileHash] Failed to hash stored file ${bucket}/${filePath}:`, err);
    return null;
  }
}

/**
 * Stores the fingerprint in a separate update, so invoice inserts keep working on a database
 * where the file_hash migration hasn't been applied yet. Never throws.
 */
export async function saveInvoiceFileHash(
  db: SupabaseClient,
  invoiceId: string,
  fileHash: string | null
): Promise<void> {
  try {
    const { error } = await db.from('invoices').update({ file_hash: fileHash }).eq('id', invoiceId);
    if (error) throw error;
  } catch (err) {
    console.error(`[fileHash] Failed to save file_hash for invoice ${invoiceId}:`, err);
  }
}

/**
 * Fingerprint of a split part: derived from the source file's hash and the page range, so the same
 * pages of the same file always get the same file_hash (pdf-lib output itself embeds timestamps),
 * and same-file duplicate detection also works for parts of a file that was split twice.
 */
export function splitPartHash(sourceHash: string, startPage: number, endPage: number): string {
  return createHash('sha256').update(`split-part:${sourceHash}:${startPage}-${endPage}`).digest('hex');
}
