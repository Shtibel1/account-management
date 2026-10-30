import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { requireClientAccess, requireInvoiceAccess } from '@/lib/auth';

/** Columns the client may not set through PATCH. */
const PROTECTED_COLUMNS = ['id', 'created_at'];

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
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const access = await requireInvoiceAccess(id);
  if (!access.ok) return access.response;

  try {
    const raw = (await request.json()) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return NextResponse.json({ error: 'Expected a JSON object' }, { status: 400 });
    }
    const body: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
    for (const col of PROTECTED_COLUMNS) delete body[col];
    // Moving an invoice to another client requires access to that client too.
    if ('client_id' in body && body.client_id !== access.value.invoice.client_id) {
      const target = await requireClientAccess(body.client_id, access.value.ctx);
      if (!target.ok) return target.response;
    }

    const { data, error } = await supabase
      .from('invoices')
      .update({
        ...body,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
