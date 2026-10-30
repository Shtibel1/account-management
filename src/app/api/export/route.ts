import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { MoveinExporter } from '@/lib/exporters/movein';
import type { Invoice, AccountMapping } from '@/shared/types';
import { requireClientsAccess, requireUser } from '@/lib/auth';

export async function POST(request: Request) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;

  try {
    const body = await request.json();
    const { ids } = body as { ids: string[] };

    if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => typeof id !== 'string')) {
      return NextResponse.json({ error: 'לא נבחרו חשבוניות' }, { status: 400 });
    }

    // 1. Fetch invoices
    const { data: invoices, error: fetchErr } = await supabase
      .from('invoices')
      .select('*')
      .in('id', ids)
      .eq('status', 'approved');

    if (fetchErr) {
      return NextResponse.json({ error: fetchErr.message }, { status: 500 });
    }

    if (!invoices || invoices.length === 0) {
      return NextResponse.json({ error: 'לא נמצאו חשבוניות מאושרות' }, { status: 400 });
    }

    // Every selected invoice must belong to a client of the user's organizations.
    const clientIds = [...new Set((invoices as Invoice[]).map((inv) => inv.client_id))];
    const access = await requireClientsAccess(clientIds, auth.value);
    if (!access.ok) return access.response;
    if (clientIds.length > 1) {
      return NextResponse.json({ error: 'יש לייצא חשבוניות של לקוח אחד בכל פעם' }, { status: 400 });
    }

    const clientId = clientIds[0];
    const exportedIds = (invoices as Invoice[]).map((inv) => inv.id);

    // 2. Fetch client + mappings
    const [clientRes, mappingsRes] = await Promise.all([
      supabase.from('clients').select('*').eq('id', clientId).single(),
      supabase.from('account_mappings').select('*').eq('client_id', clientId),
    ]);

    if (clientRes.error) {
      return NextResponse.json({ error: 'Client not found' }, { status: 500 });
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

    // 4. Generate the export file
    const exporter = new MoveinExporter();
    const buffer = exporter.export(invoices as Invoice[], mappings, client.vat_account);

    // 5. Update invoice statuses to 'exported'
    await supabase
      .from('invoices')
      .update({
        status: 'exported',
        exported_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .in('id', exportedIds);

    // 6. Return the file buffer as download attachment
    const headers = new Headers();
    headers.set('Content-Type', 'text/plain; charset=utf-8');
    headers.set('Content-Disposition', `attachment; filename="movein.dat"`);

    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers,
    });
  } catch (err) {
    console.error('Export endpoint crashed:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
