// Reviewer warnings that depend on the invoice's CURRENT data (QA: the "no date" warning stayed after
// the reviewer entered a date and approved; the line-items mismatch appeared only after approving).
// The review form shows these live while editing, and the approve call stores the same list.
import type { ExtractedData, LineItem } from '@/shared/types';
import { checkLineItemsSum, isLineItemWarning, lineItemWarnings, normalizeLineItems } from '@/shared/lineItems';
import { VAT_RATE_WARNING_PREFIX, vatRateWarning } from '@/shared/vatRate';

/** Written by the validation agent when the extraction found no invoice date. */
export const MISSING_DATE_WARNING = 'לא נמצא תאריך בחשבונית — ייתכן שמדובר בקבלה בלבד';
/** Written by the validation agent for a negative total. */
export const CREDIT_NOTE_WARNING = 'זוהתה חשבונית זיכוי (סכום שלילי) — בדוק שהקטגוריה נכונה';

type WarningData = Pick<Partial<ExtractedData>, 'invoice_date' | 'amount_before_vat' | 'vat_amount' | 'total_amount'> & {
  line_items?: LineItem[] | null;
};

function amountsOf(data: WarningData) {
  return {
    line_items: normalizeLineItems(data.line_items),
    amount_before_vat: data.amount_before_vat ?? null,
    vat_amount: data.vat_amount ?? null,
    total_amount: data.total_amount ?? null,
  };
}

/**
 * The stored warnings, minus the ones the current data no longer supports (a date was entered, the
 * total is no longer negative), with the line-item and VAT-rate warnings recomputed from the data.
 * Other warnings (auto-corrections, registrar notes, split hints) are kept as they were stored.
 */
export function liveReviewWarnings(stored: readonly string[] | null | undefined, data: WarningData): string[] {
  const amounts = amountsOf(data);
  const kept = (stored ?? []).filter((w) => {
    if (isLineItemWarning(w) || w.startsWith(VAT_RATE_WARNING_PREFIX)) return false;
    if (w === MISSING_DATE_WARNING) return !data.invoice_date;
    if (w === CREDIT_NOTE_WARNING) return data.total_amount != null && data.total_amount < 0;
    return true;
  });
  const rateWarning = vatRateWarning({ ...amounts, invoice_date: data.invoice_date ?? null });
  const out = [...kept, ...lineItemWarnings(amounts), ...(rateWarning ? [rateWarning] : [])];
  return [...new Set(out)];
}

/**
 * True when the line items don't add up to the invoice amounts: approving is allowed (a non-blocking
 * warning), but the reviewer confirms it first.
 */
export function lineItemsSumMismatch(data: WarningData): boolean {
  const amounts = amountsOf(data);
  return amounts.line_items.length > 0 && checkLineItemsSum(amounts).ok === false;
}
