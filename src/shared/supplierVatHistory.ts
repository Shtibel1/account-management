// What a supplier's human-reviewed invoices say about its VAT: an opted-in supplier whose past
// invoices carry VAT should not get a VAT-0 invoice auto-approved as "exempt".
import { normalizeVatId } from '@/shared/vatId';

export interface SupplierVatHistoryRow {
  reviewed_at: string | null;
  supplier_vat_id: string | null | undefined;
  vat_amount: number | string | null | undefined;
}

export interface SupplierVatHistory {
  /** Human-reviewed invoices of the supplier. */
  reviewedCount: number;
  /** Of those, how many had VAT above 0. */
  withVatCount: number;
}

function toAmount(value: number | string | null | undefined): number | null {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Counts the supplier's human-reviewed invoices (reviewed_at set) and how many of them had VAT. */
export function summarizeSupplierVatHistory(rows: readonly SupplierVatHistoryRow[], supplierVatId: string): SupplierVatHistory {
  const key = normalizeVatId(supplierVatId);
  let reviewedCount = 0;
  let withVatCount = 0;
  if (!key) return { reviewedCount, withVatCount };
  for (const row of rows) {
    if (!row.reviewed_at || normalizeVatId(row.supplier_vat_id ?? null) !== key) continue;
    reviewedCount++;
    const vat = toAmount(row.vat_amount);
    if (vat != null && Math.abs(vat) > 0) withVatCount++;
  }
  return { reviewedCount, withVatCount };
}

/** True when the invoice has VAT 0 on a positive total (the "exempt supplier" case). */
export function isZeroVatInvoice(data: { vat_amount?: number | null; total_amount?: number | null }): boolean {
  return data.vat_amount === 0 && data.total_amount != null && data.total_amount > 0;
}

export const ZERO_VAT_WITH_HISTORY_WARNING =
  'בחשבונית זו המע"מ 0, אך בחשבוניות קודמות של ספק זה היה מע"מ — ייתכן שהסכומים נקראו שגוי, אנא ודא';
