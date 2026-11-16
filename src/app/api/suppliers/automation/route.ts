import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import {
  fetchSupplierAutomationStatus,
  InvalidSupplierVatIdError,
  setSupplierAutoApprove,
  SupplierNotEligibleError,
} from '@/lib/supplierAutomation';
import { readJsonObject } from '@/lib/invoiceTransitions';
import { AUTO_APPROVE_HISTORY_SIZE } from '@/shared/autoApprove';
import { requireClientAccess } from '@/lib/auth';
import { normalizeVatId } from '@/shared/supplierRules';

/** Auto-approve eligibility + opt-in state for every supplier of a client. */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const clientId = searchParams.get('clientId');
  if (!clientId) {
    return NextResponse.json({ error: 'חסר לקוח' }, { status: 400 });
  }

  const access = await requireClientAccess(clientId);
  if (!access.ok) return access.response;

  try {
    const suppliers = await fetchSupplierAutomationStatus(supabase, clientId);
    return NextResponse.json({ historySize: AUTO_APPROVE_HISTORY_SIZE, suppliers });
  } catch (err) {
    console.error(`[suppliers/automation] Failed to load auto-approve status for client ${clientId}:`, err);
    return NextResponse.json({ error: 'שגיאה בטעינת מצב האישור האוטומטי' }, { status: 500 });
  }
}

/** Body: { clientId, supplierVatId, autoApprove }. Turning it on requires an eligible supplier. */
export async function PUT(request: Request) {
  const parsed = await readJsonObject<{ clientId?: unknown; supplierVatId?: unknown; autoApprove?: unknown }>(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  try {
    if (typeof body.clientId !== 'string' || typeof body.supplierVatId !== 'string' || typeof body.autoApprove !== 'boolean') {
      return NextResponse.json({ error: 'בקשה לא תקינה: נדרשים לקוח, ח.פ. ספק ומצב אישור אוטומטי' }, { status: 400 });
    }
    if (!normalizeVatId(body.supplierVatId)) {
      return NextResponse.json({ error: 'ח.פ. ספק אינו תקין' }, { status: 400 });
    }

    const access = await requireClientAccess(body.clientId);
    if (!access.ok) return access.response;

    const row = await setSupplierAutoApprove(supabase, body.clientId, body.supplierVatId, body.autoApprove);
    return NextResponse.json(row);
  } catch (err) {
    if (err instanceof SupplierNotEligibleError) {
      return NextResponse.json({ error: err.message, eligibility: err.eligibility }, { status: 409 });
    }
    if (err instanceof InvalidSupplierVatIdError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    console.error('[suppliers/automation] Failed to update auto-approve opt-in:', err);
    return NextResponse.json({ error: 'שמירת הגדרת האישור האוטומטי נכשלה' }, { status: 500 });
  }
}
