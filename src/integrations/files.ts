import type { SupabaseClient } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import { supabaseUrl } from '@/lib/supabaseConfig';
import { detectDocumentMime, isClientStorageFileUrl, MAX_DOCUMENT_BYTES } from '@/lib/ingestHelpers';
import type { ExportInvoice, InvoiceFile, InvoiceFileLoader } from '@/integrations/types';

/**
 * SERVER-ONLY: the invoice's original file for plugins that attach it to the exported document.
 *
 * invoices.file_url is editable by signed-in users, so it is never fetched as a URL: only an object
 * of THIS client in our own raw-invoices bucket is accepted (isClientStorageFileUrl), and it is read
 * with the service-role Storage API. The bytes must really be a PDF / JPEG / PNG (magic bytes).
 */

const BUCKET = 'raw-invoices';

export class InvoiceFileError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'InvoiceFileError';
  }
}

/** Object path inside raw-invoices for a trusted file_url of this client, else null (pure). */
export function storageObjectPathOf(fileUrl: string, clientId: string, baseUrl: string | null): string | null {
  if (!isClientStorageFileUrl(fileUrl, clientId, baseUrl)) return null;
  const match = /^\/storage\/v1\/object\/(?:sign|public)\/raw-invoices\/(.+)$/.exec(new URL(fileUrl).pathname);
  return match ? decodeURIComponent(match[1]) : null;
}

/** Checks the downloaded bytes and wraps them (pure). */
export function toInvoiceFile(fileName: string, bytes: Uint8Array, maxBytes = MAX_DOCUMENT_BYTES): InvoiceFile {
  if (bytes.length === 0) throw new InvoiceFileError('קובץ החשבונית ריק', 'empty_file');
  if (bytes.length > maxBytes) throw new InvoiceFileError('קובץ החשבונית גדול מדי לצירוף', 'file_too_large');
  const contentType = detectDocumentMime(bytes);
  if (!contentType) throw new InvoiceFileError('סוג קובץ החשבונית אינו נתמך לצירוף', 'unsupported_file');
  return { fileName: fileName || 'invoice', contentType, bytes };
}

export function supabaseInvoiceFileLoader(db: SupabaseClient = supabase): InvoiceFileLoader {
  return {
    async load(invoice: ExportInvoice): Promise<InvoiceFile> {
      const objectPath = storageObjectPathOf(invoice.fileUrl, invoice.clientId, process.env.SUPABASE_URL || supabaseUrl());
      if (!objectPath) throw new InvoiceFileError('קובץ החשבונית אינו קובץ אחסון של הלקוח', 'untrusted_file_url');
      const storage = db.storage.from(BUCKET);
      if (typeof storage.download !== 'function') throw new InvoiceFileError('אחסון הקבצים אינו זמין', 'storage_unavailable');
      const { data, error } = await storage.download(objectPath);
      if (error || !data) throw new InvoiceFileError('לא ניתן להוריד את קובץ החשבונית מהאחסון', 'download_failed');
      return toInvoiceFile(invoice.fileName, new Uint8Array(await data.arrayBuffer()));
    },
  };
}
