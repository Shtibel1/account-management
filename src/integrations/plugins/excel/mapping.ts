import type { ExportInvoice, InvoiceMapping } from '@/integrations/types';
import { countHe } from '@/shared/hebrewCount';

export const EXCEL_HEADERS = [
  'מספר חשבונית', 'תאריך חשבונית', 'ספק', 'ע.מ / ח.פ ספק', 'מספר הקצאה', 'קטגוריה',
  'חשבון ספק', 'חשבון הוצאה', 'חשבון מע"מ', 'לפני מע"מ', 'מע"מ', 'סה"כ', 'קובץ',
] as const;

/** A real Excel date cell (serial day number + dd/mm/yyyy format), see client.ts. */
export interface ExcelDateCell {
  kind: 'date';
  /** Excel serial date (days since 1899-12-30, the 1900 date system). */
  serial: number;
}

export type ExcelCell = string | number | ExcelDateCell;

export const EXCEL_DATE_FORMAT = 'dd/mm/yyyy';

const EXCEL_EPOCH_UTC = Date.UTC(1899, 11, 30);

/**
 * YYYY-MM-DD -> an Excel date cell (QA N19: dates were text "07/06/2026", so Excel sorted / filtered
 * them as strings). Computed from the calendar date in UTC, so the server's time zone can never
 * shift the day. Anything that is not a real date stays an empty text cell.
 */
export function toExcelDate(iso: string | null | undefined): ExcelDateCell | '' {
  const m = typeof iso === 'string' ? iso.match(/^(\d{4})-(\d{2})-(\d{2})/) : null;
  if (!m) return '';
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const utc = Date.UTC(y, mo - 1, d);
  const check = new Date(utc);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return '';
  return { kind: 'date', serial: Math.round((utc - EXCEL_EPOCH_UTC) / 86_400_000) };
}

export function isExcelDateCell(cell: ExcelCell): cell is ExcelDateCell {
  return typeof cell === 'object' && cell !== null && cell.kind === 'date';
}

export function toExcelRow(invoice: ExportInvoice, mapping: InvoiceMapping): ExcelCell[] {
  const d = invoice.data;
  return [
    d.invoice_number ?? '',
    toExcelDate(d.invoice_date),
    d.supplier_name ?? '',
    d.supplier_vat_id ?? '',
    d.allocation_number ?? '',
    d.expense_category ?? '',
    mapping.supplierAccount,
    mapping.expenseAccount ?? '',
    mapping.vatAccount,
    d.amount_before_vat ?? 0,
    d.vat_amount ?? 0,
    d.total_amount ?? 0,
    invoice.fileName,
  ];
}

/** Header + one row per invoice + a totals row. */
export function toExcelRows(items: { invoice: ExportInvoice; mapping: InvoiceMapping }[]): ExcelCell[][] {
  const rows = items.map((i) => toExcelRow(i.invoice, i.mapping));
  const sum = (col: number) => Math.round(rows.reduce((s, r) => s + (typeof r[col] === 'number' ? (r[col] as number) : 0), 0) * 100) / 100;
  return [
    [...EXCEL_HEADERS],
    ...rows,
    ['', '', `סה"כ (${countHe(rows.length, 'invoice')})`, '', '', '', '', '', '', sum(9), sum(10), sum(11), ''],
  ];
}
