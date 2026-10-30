import type { ExtractedData, LineItem } from '@/shared/types';

// Keeps the tool output (and max_tokens) bounded on long invoices; a cut-off list
// shows up as a sum mismatch, so the reviewer still gets warned.
export const MAX_LINE_ITEMS = 50;

/** Sum tolerance in ILS (same as the before_vat + vat = total check). */
export const LINE_ITEMS_SUM_TOLERANCE = 1;

/** All line-item warnings start with this, so the review form can replace them after edits. */
export const LINE_ITEMS_WARNING_PREFIX = 'שורות פריטים:';

export type LineItemsSumBasis = 'amount_before_vat' | 'total_amount';

export interface LineItemsSumCheck {
  /** null when there is nothing to compare (no line totals or no invoice amounts). */
  ok: boolean | null;
  sum: number;
  /** Which invoice amount the lines add up to, when they match. */
  matched: LineItemsSumBasis | null;
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const cleaned = value.replace(/[₪,\s]/g, '');
    if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
    return Number(cleaned);
  }
  return null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Sanitizes line items from the model (or an old/edited record): drops empty rows, coerces
 * numeric strings, fills a missing line total from quantity x unit price, caps the list.
 */
export function normalizeLineItems(raw: unknown): LineItem[] {
  if (!Array.isArray(raw)) return [];
  const items: LineItem[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const r = entry as Record<string, unknown>;
    const description = typeof r.description === 'string' && r.description.trim() ? r.description.trim() : null;
    const quantity = toNumber(r.quantity);
    const unitPrice = toNumber(r.unit_price);
    let lineTotal = toNumber(r.line_total);
    if (lineTotal == null && quantity != null && unitPrice != null) lineTotal = round2(quantity * unitPrice);
    if (description == null && lineTotal == null && unitPrice == null) continue;

    const item: LineItem = { description, quantity, unit_price: unitPrice, line_total: lineTotal };
    if (r.vat_exempt === true) item.vat_exempt = true;
    items.push(item);
    if (items.length >= MAX_LINE_ITEMS) break;
  }
  return items;
}

export function sumLineItems(items: LineItem[]): number {
  return round2(items.reduce((acc, i) => acc + (i.line_total ?? 0), 0));
}

/**
 * Line totals may be printed before VAT or VAT-inclusive, so the lines are accepted if they
 * add up to either amount_before_vat or total_amount (within 1 ILS).
 */
export function checkLineItemsSum(
  data: Pick<ExtractedData, 'amount_before_vat' | 'total_amount'> & { line_items?: LineItem[] | null }
): LineItemsSumCheck {
  const items = data.line_items ?? [];
  const priced = items.filter((i) => i.line_total != null);
  const sum = sumLineItems(priced);
  if (priced.length === 0) return { ok: null, sum, matched: null };

  const bases: LineItemsSumBasis[] = ['amount_before_vat', 'total_amount'];
  const available = bases.filter((b) => data[b] != null);
  if (available.length === 0) return { ok: null, sum, matched: null };

  const matched = available.find((b) => Math.abs(sum - (data[b] as number)) <= LINE_ITEMS_SUM_TOLERANCE) ?? null;
  return { ok: matched != null, sum, matched };
}

/** True when the invoice mixes VAT-exempt lines with taxable ones. */
export function hasMixedVat(items: LineItem[] | null | undefined): boolean {
  if (!items || items.length < 2) return false;
  const exempt = items.filter((i) => i.vat_exempt).length;
  return exempt > 0 && exempt < items.length;
}

const ils = (n: number) => `₪${n.toLocaleString('he-IL', { maximumFractionDigits: 2 })}`;

/** Hebrew reviewer warnings for line items (never rule violations). */
export function lineItemWarnings(
  data: Pick<ExtractedData, 'amount_before_vat' | 'vat_amount' | 'total_amount'> & { line_items?: LineItem[] | null }
): string[] {
  const items = data.line_items ?? [];
  if (items.length === 0) return [];
  const warnings: string[] = [];

  const sumCheck = checkLineItemsSum(data);
  if (sumCheck.ok === false) {
    const targets: string[] = [];
    if (data.amount_before_vat != null) targets.push(`לפני מע"מ ${ils(data.amount_before_vat)}`);
    if (data.total_amount != null) targets.push(`סה"כ ${ils(data.total_amount)}`);
    warnings.push(
      `${LINE_ITEMS_WARNING_PREFIX} הסכום (${ils(sumCheck.sum)}) אינו תואם לסכומי החשבונית (${targets.join(' / ')}) — ייתכן שחסרה שורה, הנחה או דמי משלוח`
    );
  }

  const exemptCount = items.filter((i) => i.vat_exempt).length;
  if (hasMixedVat(items)) {
    warnings.push(
      `${LINE_ITEMS_WARNING_PREFIX} ${exemptCount} מתוך ${items.length} שורות פטורות ממע"מ — חשבונית עם מע"מ מעורב, ודא את פיצול הסכומים`
    );
  } else if (exemptCount === items.length && data.vat_amount != null && data.vat_amount > 0) {
    warnings.push(`${LINE_ITEMS_WARNING_PREFIX} כל השורות סומנו כפטורות ממע"מ אך בחשבונית יש מע"מ — אנא ודא`);
  }

  return warnings;
}

export function isLineItemWarning(warning: string): boolean {
  return warning.startsWith(LINE_ITEMS_WARNING_PREFIX);
}
