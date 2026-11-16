// Israeli VAT rate by invoice date, and a check that an invoice's VAT matches it.
// 18% from 2025-01-01, 17% from 2015-10-01 (earlier periods kept for old documents).
import type { ExtractedData, LineItem } from '@/shared/types';
import { hasMixedVat } from '@/shared/lineItems';

interface VatPeriod {
  /** First day the rate applies (YYYY-MM-DD). */
  from: string;
  rate: number;
}

/** Newest first. */
export const IL_VAT_PERIODS: readonly VatPeriod[] = [
  { from: '2025-01-01', rate: 0.18 },
  { from: '2015-10-01', rate: 0.17 },
  { from: '2013-06-02', rate: 0.18 },
  { from: '2012-09-01', rate: 0.17 },
  { from: '2010-01-01', rate: 0.16 },
];

/** Invoices dated this many days after a rate change may still carry the previous rate (supply before the change). */
const TRANSITION_DAYS = 31;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The VAT rate in force on the given date (YYYY-MM-DD); the current rate when the date is missing or invalid. */
export function vatRateForDate(date: string | null | undefined): number {
  if (!date || !ISO_DATE.test(date)) return IL_VAT_PERIODS[0].rate;
  return (IL_VAT_PERIODS.find((p) => date >= p.from) ?? IL_VAT_PERIODS[IL_VAT_PERIODS.length - 1]).rate;
}

/** Rates a document with this date may legitimately carry (the period's rate, plus the previous one right after a change). */
export function acceptedVatRates(date: string | null | undefined): number[] {
  if (!date || !ISO_DATE.test(date)) {
    // No usable date: any rate of the recent periods is plausible
    return [...new Set(IL_VAT_PERIODS.slice(0, 2).map((p) => p.rate))];
  }
  const index = IL_VAT_PERIODS.findIndex((p) => date >= p.from);
  if (index === -1) return [IL_VAT_PERIODS[IL_VAT_PERIODS.length - 1].rate];
  const period = IL_VAT_PERIODS[index];
  const rates = [period.rate];
  const previous = IL_VAT_PERIODS[index + 1];
  if (previous) {
    const daysSinceChange = (Date.parse(date) - Date.parse(period.from)) / 86_400_000;
    if (daysSinceChange >= 0 && daysSinceChange < TRANSITION_DAYS) rates.push(previous.rate);
  }
  return [...new Set(rates)];
}

const pct = (rate: number) => `${Math.round(rate * 10000) / 100}%`;

export interface VatRateCheck {
  /** null = nothing to check (missing amounts, VAT 0 / exempt, mixed VAT lines). */
  ok: boolean | null;
  /** vat_amount / amount_before_vat. */
  actualRate: number | null;
  expectedRate: number;
}

/**
 * VAT amount vs. the statutory rate for the invoice date. Tolerance: 1 ILS or 0.2% of the net
 * amount (rounding per line), whichever is larger. VAT 0 is left to the exempt-supplier checks;
 * invoices with VAT-exempt lines mixed with taxable ones are not checked (the base is unknown).
 */
export function checkVatRate(
  data: Pick<ExtractedData, 'amount_before_vat' | 'vat_amount' | 'invoice_date'> & { line_items?: LineItem[] | null }
): VatRateCheck {
  const expectedRate = vatRateForDate(data.invoice_date);
  const before = data.amount_before_vat;
  const vat = data.vat_amount;
  if (before == null || vat == null || !Number.isFinite(before) || !Number.isFinite(vat)) {
    return { ok: null, actualRate: null, expectedRate };
  }
  const net = Math.abs(before);
  const tax = Math.abs(vat);
  if (net < 0.01 || tax === 0) return { ok: null, actualRate: null, expectedRate };
  if (hasMixedVat(data.line_items)) return { ok: null, actualRate: tax / net, expectedRate };

  const tolerance = Math.max(1, net * 0.002);
  const ok = acceptedVatRates(data.invoice_date).some((rate) => Math.abs(tax - net * rate) <= tolerance);
  return { ok, actualRate: tax / net, expectedRate };
}

export const VAT_RATE_WARNING_PREFIX = 'שיעור מע"מ:';

/** Hebrew reviewer warning when the VAT doesn't match the rate for the date, else null. */
export function vatRateWarning(
  data: Pick<ExtractedData, 'amount_before_vat' | 'vat_amount' | 'invoice_date'> & { line_items?: LineItem[] | null }
): string | null {
  const check = checkVatRate(data);
  if (check.ok !== false || check.actualRate == null) return null;
  return `${VAT_RATE_WARNING_PREFIX} המע"מ בחשבונית הוא ${pct(check.actualRate)} מהסכום לפני מע"מ, אך שיעור המע"מ בתאריך החשבונית הוא ${pct(check.expectedRate)} — ייתכן שהסכומים נקראו שגוי, אנא ודא`;
}
