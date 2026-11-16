import { NextResponse } from 'next/server';
import { requireInvoiceAccess } from '@/lib/auth';
import { signedInvoiceFileUrl, VIEW_URL_TTL_SECONDS } from '@/lib/invoiceFiles';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'private, no-store' };

/**
 * GET /api/invoices/[id]/file -> { url, expiresIn }
 * A short-lived signed URL of the invoice's original file, for the document viewer (QA #31).
 * invoices.file_url only holds a storage reference; links are signed per request, after the access
 * check, and expire after VIEW_URL_TTL_SECONDS.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await requireInvoiceAccess<{ id: string; client_id: string; file_url: string | null }>(
    id,
    'id, client_id, file_url'
  );
  if (!access.ok) return access.response;
  const invoice = access.value.invoice;

  if (!invoice.file_url) {
    return NextResponse.json({ error: 'לחשבונית אין קובץ שמור' }, { status: 404, headers: NO_STORE });
  }
  try {
    const url = await signedInvoiceFileUrl(invoice.file_url, invoice.client_id, VIEW_URL_TTL_SECONDS);
    if (!url) {
      return NextResponse.json({ error: 'קובץ החשבונית אינו זמין' }, { status: 404, headers: NO_STORE });
    }
    return NextResponse.json({ url, expiresIn: VIEW_URL_TTL_SECONDS }, { headers: NO_STORE });
  } catch (err) {
    console.error(`[Invoice file] Signing the file of invoice ${id} failed:`, err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: 'לא ניתן לפתוח את קובץ החשבונית' }, { status: 500, headers: NO_STORE });
  }
}
