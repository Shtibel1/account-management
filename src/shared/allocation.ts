// Israel Invoices model (חשבוניות ישראל): a tax invoice above the threshold (before VAT)
// needs an ITA allocation number (מספר הקצאה), otherwise the buyer can't deduct input VAT.
// Thresholds by invoice date, newest first.
export const ALLOCATION_THRESHOLDS: { from: string; amountBeforeVat: number }[] = [
  { from: '2026-06-01', amountBeforeVat: 5000 },
  { from: '2026-01-01', amountBeforeVat: 10000 },
  { from: '2025-01-01', amountBeforeVat: 20000 },
  { from: '2024-05-05', amountBeforeVat: 25000 },
];

/** Threshold in effect on the invoice date (YYYY-MM-DD), or null if the requirement didn't apply yet. */
export function allocationThreshold(invoiceDate: string | null | undefined): number | null {
  // Unknown date: assume the current (strictest) rule
  if (!invoiceDate) return ALLOCATION_THRESHOLDS[0].amountBeforeVat;
  const t = ALLOCATION_THRESHOLDS.find((r) => invoiceDate >= r.from);
  return t ? t.amountBeforeVat : null;
}

/** True when the invoice must carry an allocation number (VAT invoice above the threshold). */
export function isAllocationRequired(data: {
  invoice_date?: string | null;
  amount_before_vat?: number | null;
  vat_amount?: number | null;
}): boolean {
  const threshold = allocationThreshold(data.invoice_date);
  if (threshold == null || data.amount_before_vat == null) return false;
  // No VAT (exempt supplier / receipt) means there's no input VAT to deduct
  if (!data.vat_amount || data.vat_amount <= 0) return false;
  return data.amount_before_vat > threshold;
}

export function normalizeAllocationNumber(value: string | null | undefined): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, '');
  return digits || null;
}

/** The ITA issues 9-digit numbers; anything else is flagged for the reviewer to double-check. */
export function isAllocationNumberWellFormed(value: string | null | undefined): boolean {
  const digits = normalizeAllocationNumber(value);
  return digits != null && digits.length === 9;
}
