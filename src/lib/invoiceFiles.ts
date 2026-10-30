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
