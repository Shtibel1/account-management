import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { supabase } from '@/lib/supabase';
import { MoveinExporter, MoveinValidationError, validateMoveinInvoices } from '@/lib/exporters/movein';
import type { Invoice, AccountMapping } from '@/shared/types';
import { accessibleClientIds, isUuid, requireUser } from '@/lib/auth';
import { MOVEIN_FILE_NAME, moveinDownloadHeaders } from '@/lib/exporters/moveinResponse';
import { alreadyExportedLines, ALREADY_EXPORTED_ERROR, claimMoveinInvoices, LEGACY_CLAIM_CONCURRENCY, mapWithLimit, releaseClaims } from '@/lib/exporters/moveinClaim';
import { supabaseExportStore } from '@/integrations/store';

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
    // Exported invoices are loaded too, only to TELL the user they were left out (QA-MV B3: they
    // used to vanish silently, and a selection of exported invoices answered "no approved invoices").
    let query = supabase.from('invoices').select('*').in('id', uniqueIds).in('status', ['approved', 'exported']);
    if (allowedClients !== null) query = query.in('client_id', allowedClients);
    const { data: rows, error: fetchErr } = await query;

    if (fetchErr) {
      console.error('[Export] Failed to load invoices:', fetchErr.message);
      return NextResponse.json({ error: 'שגיאה בטעינת החשבוניות' }, { status: 500 });
    }

    const invoices = ((rows ?? []) as Invoice[]).filter((inv) => inv.status === 'approved');
    const alreadyExported = alreadyExportedLines(((rows ?? []) as Invoice[]).filter((inv) => inv.status === 'exported'));
    if (invoices.length === 0) {
      if (alreadyExported.lines.length > 0) {
        return NextResponse.json(
          { error: ALREADY_EXPORTED_ERROR, invalid: alreadyExported.lines, invoiceIds: alreadyExported.ids },
          { status: 409 }
        );
      }
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

    // 3b. Per-invoice checks (QA #12 / N13): invalid stored data (e.g. an amount "abc" approved
    // before approval validation existed) or values that don't fit the fixed-width Move-in fields
    // (e.g. a 10-digit invoice number) skip THAT invoice with a Hebrew reason; the others are
    // exported. Nothing is ever silently cut, and one bad row never fails the batch.
    const problems = validateMoveinInvoices(invoices as Invoice[], mappings, client.vat_account ?? '');
    const invalidIds = new Set(problems.map((p) => p.invoiceId));
    const valid = (invoices as Invoice[]).filter((inv) => !invalidIds.has(inv.id));
    const skippedLines = [...problems.map((p) => `${p.label}: ${p.message}`), ...alreadyExported.lines];
    if (valid.length === 0) {
      return NextResponse.json(
        {
          error: 'אף חשבונית לא יוצאה: החשבוניות לא מתאימות לפורמט Move-in. תקנו אותן ונסו שוב.',
          invalid: skippedLines,
          invoiceIds: [...invalidIds, ...alreadyExported.ids],
        },
        { status: 422 }
      );
    }

    // 4. Claim every invoice before building anything (QA N1): only ONE concurrent request can
    // claim an invoice (invoice_exports row of plugin "movein", shared with the movein plugin).
    const store = supabaseExportStore();
    const correlationId = randomUUID();
    const { claimed, skipped } = await claimMoveinInvoices({ invoices: valid, clientId, correlationId, store });
    for (const s of skipped) {
      const data = s.invoice.validated_data ?? s.invoice.extracted_data;
      const label = (typeof data?.invoice_number === 'string' && data.invoice_number.trim()) || s.invoice.file_name || s.invoice.id;
      skippedLines.push(`${label}: ${s.message}`);
    }
    if (claimed.length === 0) {
      return NextResponse.json(
        {
          error: 'החשבוניות כבר מיוצאות כעת או שיוצאו זה עתה. רעננו את הרשימה.',
          invalid: skippedLines,
          invoiceIds: skipped.map((s) => s.invoice.id),
        },
        { status: 409 }
      );
    }

    // 5. Generate the export file from the claimed invoices only.
    let buffer: Buffer;
    try {
      buffer = new MoveinExporter().export(claimed.map((c) => c.invoice), mappings, client.vat_account ?? '');
    } catch (buildErr) {
      await releaseClaims(store, claimed, buildErr instanceof Error ? buildErr.message : String(buildErr));
      throw buildErr;
    }

    // 6. Record the export (invoice_exports success, then invoices approved -> exported). Bounded
    // parallel writes: a large selection must finish well inside the ~28s request cut.
    const externalId = `${MOVEIN_FILE_NAME}#${correlationId}`;
    await mapWithLimit(claimed, LEGACY_CLAIM_CONCURRENCY, (c) =>
      store.complete(c.record.id, { status: 'success', external_id: externalId })
    );
    try {
      await store.markInvoicesExported(claimed.map((c) => c.invoice.id));
    } catch (markErr) {
      // invoice_exports already holds the truth (a parallel request can't claim these invoices).
      console.error('[Export] Failed to mark invoices exported:', markErr instanceof Error ? markErr.message : String(markErr));
    }

    // 7. Return the Windows-1255 bytes as a binary download (see moveinDownloadHeaders). Invoices
    // left out of the file are listed in X-Export-Skipped (URI-encoded JSON array of Hebrew lines).
    const headers = moveinDownloadHeaders(buffer.length);
    headers.set('X-Export-Count', String(claimed.length));
    if (skippedLines.length > 0) {
      headers.set('X-Export-Skipped', encodeURIComponent(JSON.stringify(skippedLines.slice(0, 8).map((l) => l.slice(0, 140)))));
      headers.set('X-Export-Skipped-Count', String(skippedLines.length));
    }
    return new Response(new Uint8Array(buffer), { status: 200, headers });
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
