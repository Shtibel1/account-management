import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { requireClientAccess, requireInvoiceAccess } from '@/lib/auth';
import { isClientStorageFileUrl } from '@/lib/ingestHelpers';
import { isMockMode, supabaseUrl } from '@/lib/supabaseConfig';
import { dbErrorResponse, readJsonObject, transitionInvoice } from '@/lib/invoiceTransitions';
import { canTransition, DELETABLE_STATUSES, isInvoiceStatus, STATUS_LABELS, transitionRefusedMessage } from '@/shared/invoiceStatus';
import type { InvoiceStatus } from '@/shared/types';

/** Columns the client may not set through PATCH. */
const PROTECTED_COLUMNS = [
  'id',
  'created_at',
  // Accountant review loop audit trail: written only by POST /api/invoices/[id]/return and the pipeline.
  'return_reason_code',
  'return_reason',
  'returned_at',
  'returned_by',
  'resubmitted_invoice_id',
  'resubmission_of',
  // Approval / export audit: written only by the approve and export routes.
  'reviewed_at',
  'exported_at',
  'ai_confidence',
];

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const access = await requireInvoiceAccess<Record<string, unknown>>(id, '*');
  if (!access.ok) return access.response;

  try {
    return NextResponse.json(access.value.invoice);
  } catch (err) {
    console.error(`[invoices/${id}] GET failed:`, err);
    return NextResponse.json({ error: 'שגיאה בטעינת החשבונית' }, { status: 500 });
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const access = await requireInvoiceAccess<{ id: string; client_id: string; status: InvoiceStatus }>(id, 'id, client_id, status');
  if (!access.ok) return access.response;
  const current = access.value.invoice.status;

  const parsed = await readJsonObject(request);
  if (!parsed.ok) return parsed.response;

  try {
    const body: Record<string, unknown> = { ...parsed.body };
    for (const col of PROTECTED_COLUMNS) delete body[col];
    if ('status' in body && body.status !== current) {
      // 'returned' is set only through the flagged return route (reason + client notification).
      if (body.status === 'returned') {
        return NextResponse.json({ error: 'החזרה ללקוח מתבצעת דרך "החזר ללקוח" בלבד' }, { status: 400 });
      }
      // Every other status change goes through its own route (approve / export / retry / reopen);
      // PATCH may only make the plain "reject" transition (src/shared/invoiceStatus.ts).
      if (!canTransition(current, body.status, 'reject')) {
        return NextResponse.json(
          {
            error: `לא ניתן לשנות את סטטוס החשבונית מ"${STATUS_LABELS[current] ?? current}" ל"${
              isInvoiceStatus(body.status) ? STATUS_LABELS[body.status] : 'סטטוס לא מוכר'
            }" בעדכון ישיר`,
          },
          { status: 409 }
        );
      }
    } else {
      delete body.status;
    }
    // An exported invoice was already posted to the books: its data is final until reopened.
    if (current === 'exported' && ('validated_data' in body || 'extracted_data' in body || 'client_id' in body)) {
      return NextResponse.json({ error: 'החשבונית כבר יוצאה להנהלת החשבונות ולא ניתן לשנות את נתוניה' }, { status: 409 });
    }
    // Approved data is validated by the approve route; it may not be replaced unchecked afterwards
    // (reopen the invoice to review first).
    if (current !== 'review' && ('validated_data' in body || 'extracted_data' in body)) {
      return NextResponse.json(
        { error: 'ניתן לערוך את נתוני החשבונית רק כשהיא ממתינה לבדיקה (יש לפתוח אותה מחדש לבדיקה)' },
        { status: 409 }
      );
    }
    if (Object.keys(body).length === 0) {
      return NextResponse.json({ error: 'לא התקבלו שדות לעדכון' }, { status: 400 });
    }
    // Moving an invoice to another client requires access to that client too.
    if ('client_id' in body && body.client_id !== access.value.invoice.client_id) {
      const target = await requireClientAccess(body.client_id, access.value.ctx);
      if (!target.ok) return target.response;
    }

    if ('status' in body) {
      // A status change only applies if nobody changed the status meanwhile (conditional update).
      const outcome = await transitionInvoice(supabase, id, [current], { ...body, status: body.status as InvoiceStatus });
      if (!outcome.ok) {
        return outcome.reason === 'conflict'
          ? NextResponse.json({ error: 'החשבונית שונתה בינתיים - יש לרענן את הדף' }, { status: 409 })
          : dbErrorResponse(outcome.error);
      }
    } else {
      const { error } = await supabase
        .from('invoices')
        .update({ ...body, updated_at: new Date().toISOString() })
        .eq('id', id);
      if (error) return dbErrorResponse(error);
    }

    const { data, error } = await supabase.from('invoices').select('*').eq('id', id).single();
    if (error || !data) return NextResponse.json({ error: 'שגיאה בטעינת החשבונית לאחר העדכון' }, { status: 500 });

    return NextResponse.json(data);
  } catch (err) {
    console.error(`[invoices/${id}] PATCH failed:`, err);
    return NextResponse.json({ error: 'שגיאה בעדכון החשבונית' }, { status: 500 });
  }
}

/** Storage object path of a raw-invoices URL ("<clientId>/<file>"), or null. */
function storageObjectPath(fileUrl: string): string | null {
  try {
    const match = /^\/storage\/v1\/object\/(?:sign|public)\/raw-invoices\/(.+)$/.exec(new URL(fileUrl).pathname);
    return match ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

/**
 * Deletes a failed document (status 'error') together with its stored file. Reviewed, approved or
 * exported invoices are never deleted (409): reject them instead.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const access = await requireInvoiceAccess<{ id: string; client_id: string; status: InvoiceStatus; file_url: string | null }>(
    id,
    'id, client_id, status, file_url'
  );
  if (!access.ok) return access.response;
  const invoice = access.value.invoice;

  if (!DELETABLE_STATUSES.includes(invoice.status)) {
    return NextResponse.json(
      { error: `${transitionRefusedMessage('delete', invoice.status)} - ניתן למחוק רק מסמכים שעיבודם נכשל`, status: invoice.status },
      { status: 409 }
    );
  }

  try {
    const { error } = await supabase.from('invoices').delete().eq('id', id).in('status', [...DELETABLE_STATUSES]);
    if (error) return dbErrorResponse(error, 'שגיאה במחיקת החשבונית');

    // Best effort: the row is gone either way; an orphaned file is only wasted storage.
    if (
      invoice.file_url &&
      !isMockMode() &&
      isClientStorageFileUrl(invoice.file_url, invoice.client_id, process.env.SUPABASE_URL || supabaseUrl())
    ) {
      const path = storageObjectPath(invoice.file_url);
      if (path) {
        const { error: storageErr } = await supabase.storage.from('raw-invoices').remove([path]);
        if (storageErr) console.error(`[invoices/${id}] Failed to delete stored file ${path}:`, storageErr);
      }
    }
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error(`[invoices/${id}] DELETE failed:`, err);
    return NextResponse.json({ error: 'שגיאה במחיקת החשבונית' }, { status: 500 });
  }
}
