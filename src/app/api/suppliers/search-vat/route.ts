import { NextResponse } from 'next/server';
import { searchVatIdByName } from '@/utils/businessLookup';
import { requireUser } from '@/lib/auth';
import { isGenericSupplierName } from '@/shared/supplierRules';

export async function GET(request: Request) {
  // No tenant data involved (public registrar lookup), but it costs outbound calls: users only.
  const auth = await requireUser();
  if (!auth.ok) return auth.response;

  const { searchParams } = new URL(request.url);
  const name = searchParams.get('name')?.trim();

  if (!name) {
    return NextResponse.json({ error: 'חסר שם ספק לחיפוש' }, { status: 400 });
  }
  // The catch-all supplier (ספקים שונים) is not a business: never look it up
  if (isGenericSupplierName(name)) {
    return NextResponse.json({ vatId: null });
  }

  try {
    const vatId = await searchVatIdByName(name);
    return NextResponse.json({ vatId });
  } catch (err) {
    console.error('[suppliers/search-vat] Registrar lookup failed:', err);
    return NextResponse.json({ error: 'החיפוש במאגר רשם החברות נכשל, נסו שוב מאוחר יותר' }, { status: 502 });
  }
}
