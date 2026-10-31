import { supabase } from '@/lib/supabase';
import { clientStorageObjectPath, storageReferenceUrl } from '@/lib/ingestHelpers';
import { isMockMode, supabaseUrl } from '@/lib/supabaseConfig';

/**
 * SERVER-ONLY: access to invoice files in the private raw-invoices bucket (QA #31).
 *
 * invoices.file_url stores a storage REFERENCE (`/storage/v1/object/authenticated/raw-invoices/<path>`),
 * which is not a bearer link. Whoever needs the bytes gets a short-lived signed URL on demand:
 *   - the document viewer: GET /api/invoices/[id]/file (10 minutes, after the access check);
 *   - the pipeline: runOrchestrationPipeline signs a fresh URL for its own run (1 hour);
 *   - split / plugins: read through the service-role Storage API.
 * Legacy rows with 1-year signed URLs are rewritten by the migration; until then the object path is
 * derived from them the same way (and they get re-signed, never handed out as stored).
 */

export const RAW_BUCKET = 'raw-invoices';
/** Viewer links (review page). */
export const VIEW_URL_TTL_SECONDS = 10 * 60;
/** Pipeline runs (OCR + vision extraction fetch the file during the run). */
export const PIPELINE_URL_TTL_SECONDS = 60 * 60;

function storageBaseUrl(): string | null {
  return process.env.SUPABASE_URL || supabaseUrl();
}

/** The value stored in invoices.file_url for a raw-invoices object path. */
export function storedFileUrlFor(objectPath: string): string {
  const base = storageBaseUrl();
  // Mock mode: files are served from public/uploads (src/utils/supabase/mockClient.ts).
  if (!base || isMockMode()) return `/uploads/${RAW_BUCKET}/${objectPath}`;
  return storageReferenceUrl(base, objectPath);
}

/** Object path of a stored file_url of this client, or null when it isn't one of our objects. */
export function invoiceObjectPath(fileUrl: string | null | undefined, clientId: string): string | null {
  return clientStorageObjectPath(fileUrl, clientId, storageBaseUrl());
}

/** Short-lived signed URL of an object path, or null. */
export async function signObjectPath(objectPath: string, ttlSeconds: number): Promise<string | null> {
  const { data, error } = await supabase.storage.from(RAW_BUCKET).createSignedUrl(objectPath, ttlSeconds);
  if (error || !data?.signedUrl) {
    console.error(`[invoiceFiles] Signing ${RAW_BUCKET} object failed:`, error?.message ?? 'no URL');
    return null;
  }
  return data.signedUrl;
}

/**
 * A fetchable, short-lived URL for a stored file_url of this client. Mock mode returns the value
 * unchanged. Null when the URL isn't a storage file of this client or signing failed.
 */
export async function signedInvoiceFileUrl(fileUrl: string | null | undefined, clientId: string, ttlSeconds: number): Promise<string | null> {
  if (!fileUrl) return null;
  if (isMockMode()) return fileUrl;
  const objectPath = invoiceObjectPath(fileUrl, clientId);
  if (!objectPath) return null;
  return signObjectPath(objectPath, ttlSeconds);
}

/** Bytes of a stored file_url of this client (service-role Storage API), or null. */
export async function downloadInvoiceFile(fileUrl: string | null | undefined, clientId: string): Promise<Buffer | null> {
  if (!fileUrl) return null;
  if (isMockMode()) {
    const res = await fetch(fileUrl).catch(() => null);
    return res?.ok ? Buffer.from(await res.arrayBuffer()) : null;
  }
  const objectPath = invoiceObjectPath(fileUrl, clientId);
  if (!objectPath) return null;
  const { data, error } = await supabase.storage.from(RAW_BUCKET).download(objectPath);
  if (error || !data) {
    console.error(`[invoiceFiles] Download of ${RAW_BUCKET} object failed:`, error?.message ?? 'no data');
    return null;
  }
  return Buffer.from(await data.arrayBuffer());
}

/** For logs: a URL without its query string (signed URLs carry a bearer token there). */
export function redactUrlForLog(url: string | null | undefined): string {
  if (!url) return '';
  return url.split('?')[0];
}

/** The part of the Supabase client relocateInvoiceFiles uses (injectable for tests). */
export interface FileMoveDb {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
  storage: {
    from: (bucket: string) => {
      copy: (from: string, to: string) => PromiseLike<{ error: { message: string } | null }>;
      remove: (paths: string[]) => PromiseLike<{ error: { message: string } | null }>;
    };
  };
}

export type FileMove =
  | { ok: true; update: { file_url?: string; original_file_url?: string }; oldPaths: string[]; created: string[] }
  | { ok: false; error: string };

/**
 * Moving an invoice to another client (QA round 7): its file (and the original of a split part) must
 * live under the new client's folder, because every reader only trusts files of the invoice's own
 * client (isClientStorageFileUrl) and client deletion works per folder. Copies the objects to
 * <newClientId>/<name> and returns the new file_url values; the old objects are removed afterwards
 * by removeUnusedOldFiles (a split original may still serve sibling parts).
 */
export async function relocateInvoiceFiles(
  db: FileMoveDb,
  invoice: { client_id: string; file_url?: string | null; original_file_url?: string | null },
  newClientId: string
): Promise<FileMove> {
  if (isMockMode()) return { ok: true, update: {}, oldPaths: [], created: [] };
  const update: { file_url?: string; original_file_url?: string } = {};
  const oldPaths: string[] = [];
  const created: string[] = [];
  for (const column of ['file_url', 'original_file_url'] as const) {
    const path = invoiceObjectPath(invoice[column], invoice.client_id);
    if (!path) continue;
    const target = `${newClientId}/${path.slice(path.indexOf('/') + 1)}`;
    const { error } = await db.storage.from(RAW_BUCKET).copy(path, target);
    // Already there: a sibling split part moved the same original before
    if (error && !/already exists|duplicate/i.test(error.message)) {
      await discardCopies(db, created);
      return { ok: false, error: `copy ${column}: ${error.message}` };
    }
    if (!error) created.push(target);
    update[column] = storedFileUrlFor(target);
    oldPaths.push(path);
  }
  return { ok: true, update, oldPaths, created };
}

/** Removes the copies a move made when the invoice update itself then failed (best effort). */
export async function discardCopies(db: FileMoveDb, created: string[]): Promise<void> {
  if (created.length === 0) return;
  const { error } = await db.storage.from(RAW_BUCKET).remove(created);
  if (error) console.error(`[invoiceFiles] Removing ${created.length} copies of a failed move failed:`, error.message);
}

/** Removes old objects of a moved invoice that no invoice references any more (best effort). */
export async function removeUnusedOldFiles(db: FileMoveDb, oldPaths: string[]): Promise<void> {
  if (oldPaths.length === 0) return;
  const { data, error } = await db.rpc('storage_paths_in_use', { p_paths: oldPaths });
  if (error) {
    console.error('[invoiceFiles] File reference check failed, old files kept:', error.message);
    return;
  }
  const inUse = new Set((data as string[] | null) ?? []);
  const unused = oldPaths.filter((p) => !inUse.has(p));
  if (unused.length === 0) return;
  const { error: removeErr } = await db.storage.from(RAW_BUCKET).remove(unused);
  if (removeErr) console.error(`[invoiceFiles] Removing ${unused.length} old files failed:`, removeErr.message);
}
