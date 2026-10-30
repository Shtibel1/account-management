import type { ExportInvoice, InvoiceMapping } from '@/integrations/types';

export const EXCEL_HEADERS = [
  'מספר חשבונית', 'תאריך חשבונית', 'ספק', 'ע.מ / ח.פ ספק', 'מספר הקצאה', 'קטגוריה',
  'חשבון ספק', 'חשבון הוצאה', 'חשבון מע"מ', 'לפני מע"מ', 'מע"מ', 'סה"כ', 'קובץ',
] as const;

export type ExcelCell = string | number;

/** YYYY-MM-DD -> DD/MM/YYYY */
function formatDate(iso: string | null): string {
  const m = iso?.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
}

export function toExcelRow(invoice: ExportInvoice, mapping: InvoiceMapping): ExcelCell[] {
  const d = invoice.data;
  return [
    d.invoice_number ?? '',
    formatDate(d.invoice_date),
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
    ['', '', `סה"כ (${rows.length} חשבוניות)`, '', '', '', '', '', '', sum(9), sum(10), sum(11), ''],
  ];
}
