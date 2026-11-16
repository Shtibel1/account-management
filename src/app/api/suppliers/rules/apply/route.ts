import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { reapplySupplierRules, type SupplierRef } from '@/lib/supplierAutomation';
import { requireClientAccess } from '@/lib/auth';

/**
 * Re-applies a client's supplier rules to its invoices still in review (validated_data only).
 * Body: { clientId, suppliers?: { name?, vatId? }[] } — pass the old and new name / VAT ID of a
 * changed or deleted rule; omit suppliers to re-apply to every invoice in review.
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { clientId?: unknown; suppliers?: unknown };
    const clientId = typeof body.clientId === 'string' ? body.clientId : '';
    if (!clientId) {
      return NextResponse.json({ error: 'Missing clientId' }, { status: 400 });
    }

    const access = await requireClientAccess(clientId);
    if (!access.ok) return access.response;

    let suppliers: SupplierRef[] | undefined;
    if (body.suppliers !== undefined) {
      if (!Array.isArray(body.suppliers)) {
        return NextResponse.json({ error: 'suppliers must be an array' }, { status: 400 });
      }
      suppliers = (body.suppliers as { name?: unknown; vatId?: unknown }[]).map((s) => ({
        name: typeof s?.name === 'string' ? s.name : null,
        vatId: typeof s?.vatId === 'string' ? s.vatId : null,
      }));
    }

    const result = await reapplySupplierRules(supabase, clientId, suppliers);
    return NextResponse.json(result);
  } catch (err) {
    console.error('[suppliers/rules/apply] Failed to re-apply supplier rules:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
