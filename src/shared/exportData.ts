import type { ExtractedData } from '@/shared/types';
import { isValidIsoDate } from '@/shared/approvalValidation';

/**
 * Checks of an invoice's STORED data before it is exported (pure, shared by POST /api/export and
 * the integrations export runner).
 *
 * Approval validates the data (src/shared/approvalValidation.ts), but rows approved before that
 * validation existed - or written by an older build - may hold garbage such as total_amount "abc" or
 * invoice_date "31/02/2026". Such an invoice must fail ON ITS OWN with a Hebrew reason; it must never
 * crash the whole export batch (QA #12). Repair: reopen the invoice, fix the values in review and
 * approve it again (see docs/integrations.md, "Invalid stored data").
 */

/** Width of the Move-in reference field (invoice number). Kept here so the approval can warn. */
export const MOVEIN_INVOICE_NUMBER_WIDTH = 9;

const AMOUNT_FIELDS: [keyof ExtractedData, string][] = [
  ['amount_before_vat', 'הסכום לפני מע"מ'],
  ['vat_amount', 'סכום המע"מ'],
  ['total_amount', 'הסכום לתשלום'],
];

const TEXT_FIELDS: [keyof ExtractedData, string][] = [
  ['invoice_number', 'מספר החשבונית'],
  ['supplier_name', 'שם הספק'],
  ['supplier_vat_id', 'מספר העוסק של הספק'],
  ['expense_category', 'סיווג ההוצאה'],
  ['allocation_number', 'מספר ההקצאה'],
  ['bank_name', 'שם הבנק'],
  ['bank_branch_code', 'קוד הסניף'],
  ['bank_branch_name', 'שם הסניף'],
  ['bank_account', 'מספר החשבון'],
];

/**
 * Hebrew problems that make the stored data unexportable (empty = OK). Never throws, whatever the
 * stored JSON holds.
 */
export function exportDataProblems(data: unknown): string[] {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return ['אין נתונים שמורים לחשבונית'];
  const d = data as Record<string, unknown>;
  const problems: string[] = [];

  const date = d.invoice_date;
  if (date === null || date === undefined || date === '') problems.push('חסר תאריך חשבונית');
  else if (!isValidIsoDate(date)) problems.push(`תאריך החשבונית "${clip(date)}" אינו תקין`);

  for (const [key, label] of AMOUNT_FIELDS) {
    const value = d[key as string];
    if (value === null || value === undefined) problems.push(`חסר ${label}`);
    else if (typeof value !== 'number' || !Number.isFinite(value)) problems.push(`${label} "${clip(value)}" אינו מספר`);
  }

  for (const [key, label] of TEXT_FIELDS) {
    const value = d[key as string];
    if (value !== null && value !== undefined && typeof value !== 'string') problems.push(`${label} אינו טקסט תקין`);
  }
  return problems;
}

/**
 * Non-blocking warnings shown when an invoice is approved: values that are valid for the books in
 * general but don't fit a specific export format. Move-in's reference field holds 9 characters, so
 * a longer invoice number will be refused by the Move-in export (QA N13). Other targets (iCount,
 * Morning, SUMIT, Excel, webhook) accept it, so approval warns instead of blocking.
 */
export function exportCompatibilityWarnings(data: Partial<ExtractedData> | null | undefined): string[] {
  const warnings: string[] = [];
  const number = typeof data?.invoice_number === 'string' ? data.invoice_number.trim() : '';
  if (number.length > MOVEIN_INVOICE_NUMBER_WIDTH) {
    warnings.push(
      `מספר החשבונית "${number}" ארוך מ-${MOVEIN_INVOICE_NUMBER_WIDTH} תווים: ייצוא ל-Move-in ידלג על החשבונית עד שהמספר יקוצר (ייצוא למערכות אחרות אינו מושפע).`
    );
  }
  return warnings;
}

function clip(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}
