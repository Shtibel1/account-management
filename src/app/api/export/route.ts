import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { MoveinExporter, MoveinValidationError, validateMoveinInvoices } from '@/lib/exporters/movein';
import type { Invoice, AccountMapping } from '@/shared/types';
import { accessibleClientIds, isUuid, requireUser } from '@/lib/auth';
import { moveinDownloadHeaders } from '@/lib/exporters/moveinResponse';

const NOT_FOUND = 'לא נמצאו חשבוניות מאושרות';

export async function POST(request: Request) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;

  try {
    const body = await request.json().catch(() => null);
    const ids = (body as { ids?: unknown } | null)?.ids;

    if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => typeof id !== 'string')) {
      return NextResponse.json({ error: 'לא נבחרו חשבוניות' }, { status: 400 });
    }
    const uniqueIds = [...new Set(ids as string[])];
    // Not a UUID can't be an invoice: same answer as an unknown id.
    if (!auth.value.mock && uniqueIds.some((id) => !isUuid(id))) {
      return NextResponse.json({ error: NOT_FOUND }, { status: 400 });
    }

    // 1. Fetch the approved invoices - only of clients the user may access. Filtering BEFORE the
    // empty check means an id of another office answers exactly like an unknown id (no 403 that
    // would reveal that the id is an approved invoice somewhere).
    const allowedClients = await accessibleClientIds(auth.value);
    if (allowedClients !== null && allowedClients.length === 0) {
      return NextResponse.json({ error: NOT_FOUND }, { status: 400 });
    }
    let query = supabase.from('invoices').select('*').in('id', uniqueIds).eq('status', 'approved');
    if (allowedClients !== null) query = query.in('client_id', allowedClients);
    const { data: invoices, error: fetchErr } = await query;

    if (fetchErr) {
      console.error('[Export] Failed to load invoices:', fetchErr.message);
      return NextResponse.json({ error: 'שגיאה בטעינת החשבוניות' }, { status: 500 });
    }

    if (!invoices || invoices.length === 0) {
      return NextResponse.json({ error: NOT_FOUND }, { status: 400 });
    }

    const clientIds = [...new Set((invoices as Invoice[]).map((inv) => inv.client_id))];
    if (clientIds.length > 1) {
      return NextResponse.json({ error: 'יש לייצא חשבוניות של לקוח אחד בכל פעם' }, { status: 400 });
    }

    const clientId = clientIds[0];

    // 2. Fetch client + mappings
    const [clientRes, mappingsRes] = await Promise.all([
      supabase.from('clients').select('*').eq('id', clientId).single(),
      supabase.from('account_mappings').select('*').eq('client_id', clientId),
    ]);

    if (clientRes.error || !clientRes.data) {
      return NextResponse.json({ error: 'הלקוח לא נמצא' }, { status: 404 });
    }
    if (mappingsRes.error) {
      console.error('[Export] Failed to load account mappings:', mappingsRes.error.message);
      return NextResponse.json({ error: 'שגיאה בטעינת מיפויי החשבונות' }, { status: 500 });
    }

    const client = clientRes.data;
    const mappings = (mappingsRes.data as AccountMapping[]) ?? [];

    // 3. Check for missing mappings
    const missing: string[] = [];
    for (const inv of invoices as Invoice[]) {
      const data = inv.validated_data ?? inv.extracted_data;
      if (!data) continue;

      // Suppliers now fallback to "ספקים שונים" code 3499 if not mapped, so they are never "missing"

      if (
        data.expense_category &&
        !mappings.find((m) => m.mapping_type === 'category' && m.key === data.expense_category)
      ) {
        missing.push(`קטגוריה: ${data.expense_category}`);
      }
    }

    if (missing.length > 0) {
      return NextResponse.json(
        {
          error: 'מיפויים חסרים',
          missing: [...new Set(missing)],
        },
        { status: 422 }
      );
    }

    // 3b. Values that don't fit the fixed-width Move-in fields (e.g. a 10-digit invoice number in
    // the 9-character reference field) are rejected, never silently cut.
    const tooLong = validateMoveinInvoices(invoices as Invoice[], mappings, client.vat_account ?? '');
    if (tooLong.length > 0) {
      return NextResponse.json(
        {
          error: 'חלק מהחשבוניות לא מתאימות לפורמט Move-in. תקנו אותן ונסו שוב.',
          invalid: tooLong.map((p) => `${p.label}: ${p.message}`),
          invoiceIds: [...new Set(tooLong.map((p) => p.invoiceId))],
        },
        { status: 422 }
      );
    }

    // 4. Generate the export file
    const exporter = new MoveinExporter();
    const buffer = exporter.export(invoices as Invoice[], mappings, client.vat_account ?? '');
    const exportedIds = (invoices as Invoice[]).map((inv) => inv.id);

    // 5. Update invoice statuses to 'exported'
    await supabase
      .from('invoices')
      .update({
        status: 'exported',
        exported_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .in('id', exportedIds);

    // 6. Return the Windows-1255 bytes as a binary download (see moveinDownloadHeaders).
    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: moveinDownloadHeaders(buffer.length),
    });
  } catch (err) {
    if (err instanceof MoveinValidationError) {
      return NextResponse.json(
        { error: 'חלק מהחשבוניות לא מתאימות לפורמט Move-in. תקנו אותן ונסו שוב.', invalid: err.problems.map((p) => `${p.label}: ${p.message}`) },
        { status: 422 }
      );
    }
    console.error('Export endpoint crashed:', err);
    return NextResponse.json({ error: 'הייצוא נכשל' }, { status: 500 });
  }
}
