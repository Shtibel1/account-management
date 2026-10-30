import { supabase } from '@/lib/supabase';
import { supabaseUrl } from '@/lib/supabaseConfig';
import { detectDocumentMime, isClientStorageFileUrl, MAX_DOCUMENT_BYTES } from '@/lib/ingestHelpers';
import type { ExportInvoice, InvoiceFile, InvoiceFileReader } from '@/integrations/types';

/**
 * SERVER-ONLY: reads an invoice's stored document from the raw-invoices bucket for plugins that
 * attach the PDF to the exported document. Only a file of the invoice's own client in our own
 * Supabase project is read (file_url is user-editable, so it is never fetched as a URL).
 */

const RAW_BUCKET = 'raw-invoices';

/** Object path inside raw-invoices for a file_url of this client, or null. Pure. */
export function storageObjectPath(fileUrl: string, clientId: string, baseUrl: string | null): string | null {
  if (!isClientStorageFileUrl(fileUrl, clientId, baseUrl)) return null;
  const match = /^\/storage\/v1\/object\/(?:sign|public)\/raw-invoices\/(.+)$/.exec(new URL(fileUrl).pathname);
  return match ? decodeURIComponent(match[1]) : null;
}

export function supabaseInvoiceFileReader(): InvoiceFileReader {
  return {
    async read(invoice: ExportInvoice): Promise<InvoiceFile | null> {
      const path = storageObjectPath(invoice.fileUrl, invoice.clientId, process.env.SUPABASE_URL || supabaseUrl());
      if (!path) return null;
      try {
        const storage = supabase.storage.from(RAW_BUCKET);
        if (typeof storage.download !== 'function') return null; // local mock storage
        const { data, error } = await storage.download(path);
        if (error || !data) return null;
        const bytes = new Uint8Array(await data.arrayBuffer());
        if (bytes.length === 0 || bytes.length > MAX_DOCUMENT_BYTES) return null;
        const contentType = detectDocumentMime(bytes);
        if (!contentType) return null;
        return { bytes, contentType, fileName: invoice.fileName || path.split('/').pop() || 'invoice' };
      } catch (err) {
        console.error(`[integrations] Failed to read the stored file of invoice ${invoice.id}:`, err instanceof Error ? err.message : String(err));
        return null;
      }
    },
  };
}
