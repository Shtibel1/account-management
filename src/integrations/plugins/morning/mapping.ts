import type { ExportInvoice, InvoiceMapping } from '@/integrations/types';

/**
 * ExportInvoice -> Morning (Green Invoice) expense (pure). API: POST /expenses (ExpenseRequest) and
 * POST /expenses/search (SearchExpensesRequest), https://developers.morning.co/api.
 *
 * Morning expense document types used here:
 *   305 = חשבונית מס, 320 = חשבונית מס / קבלה, 330 = חשבונית זיכוי.
 * `amount` is the total INCLUDING VAT, `vat` the VAT part (may not exceed amount). Credit notes are
 * sent with positive amounts and documentType 330 (the type carries the sign).
 */

export type MorningDocumentType = 305 | 320 | 330;

export const MORNING_DOCUMENT_TYPES: Record<MorningDocumentType, string> = {
  305: 'חשבונית מס',
  320: 'חשבונית מס / קבלה',
  330: 'חשבונית זיכוי',
};

export interface MorningSupplier {
  name: string;
  taxId?: string;
  accountingKey?: string;
  /** Create the supplier in Morning when it does not exist yet. */
  add: true;
}

export interface MorningExpenseRequest {
  documentType: MorningDocumentType;
  number: string;
  /** YYYY-MM-DD */
  date: string;
  /** First day of the reporting month, YYYY-MM-01. */
  reportingDate: string;
  currency: 'ILS';
  currencyRate: 1;
  amount: number;
  vat: number;
  description: string;
  /** Our invoice id, so a document in Morning can be traced back. */
  remarks: string;
  allocationNumber?: string;
  supplier: MorningSupplier;
  accountingClassification: { key: string };
  active: true;
}

export interface MorningSearchRequest {
  number: string;
  fromDate: string;
  toDate: string;
  page: number;
  pageSize: number;
}

/** Expense as returned by Morning (only the fields we read). */
export interface MorningExpense {
  id?: string;
  number?: string | number;
  date?: string;
  documentType?: number;
  status?: number;
  url?: string;
  supplier?: { id?: string; name?: string; taxId?: string | number };
}

export interface MappingOptions {
  /** Document type for a regular (non-credit) invoice whose OCR text does not tell. */
  defaultDocumentType: 305 | 320;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function isNum(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

/** Our idempotency marker, stored in the expense remarks. */
export function morningRemarks(invoiceId: string): string {
  return `invoice-scan:${invoiceId}`;
}

/** First day of the invoice's month (Morning reportingDate), or null for an invalid date. */
export function reportingDateOf(date: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date ?? '');
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return null;
  return `${m[1]}-${m[2]}-01`;
}

/** Shifts a YYYY-MM-DD date by `days` (UTC). */
export function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Amounts signed like the document: negative total = credit note. */
export function isCreditNote(invoice: ExportInvoice): boolean {
  const d = invoice.data;
  if (isNum(d.total_amount) && d.total_amount < 0) return true;
  if (!isNum(d.total_amount) && isNum(d.amount_before_vat) && d.amount_before_vat < 0) return true;
  const text = invoice.raw.ocr_text ?? '';
  return /חשבונית\s*(מס\s*)?זיכוי|הודעת\s*זיכוי/.test(text.slice(0, 3000));
}

export function morningDocumentType(invoice: ExportInvoice, options: MappingOptions): MorningDocumentType {
  if (isCreditNote(invoice)) return 330;
  const text = (invoice.raw.ocr_text ?? '').slice(0, 3000);
  if (/חשבונית\s*מס\s*[/\\-]?\s*קבלה/.test(text)) return 320;
  if (/חשבונית\s*מס(?!\s*[/\\-]?\s*קבלה)/.test(text)) return 305;
  return options.defaultDocumentType;
}

/**
 * VAT split: amount = total incl. VAT, vat = VAT part, both absolute (credit notes too). Missing
 * values are derived from the other two; null when there is not enough data.
 */
export function vatSplit(data: ExportInvoice['data']): { amount: number; vat: number } | null {
  const total = isNum(data.total_amount) ? Math.abs(data.total_amount) : null;
  const before = isNum(data.amount_before_vat) ? Math.abs(data.amount_before_vat) : null;
  const vatRaw = isNum(data.vat_amount) ? Math.abs(data.vat_amount) : null;
  const amount = total ?? (before !== null ? before + (vatRaw ?? 0) : null);
  if (amount === null) return null;
  const vat = vatRaw ?? (before !== null && total !== null ? total - before : 0);
  return { amount: round2(amount), vat: round2(Math.max(0, vat)) };
}

function digits(value: string | null | undefined): string | null {
  const d = (value ?? '').replace(/\D/g, '');
  return d ? d : null;
}

function clean(value: string | null | undefined, max: number): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Problems that block the export to Morning (Hebrew, shown to the user). */
export function morningValidationProblems(invoice: ExportInvoice, mapping: InvoiceMapping): string[] {
  const d = invoice.data;
  const problems: string[] = [];
  if (!clean(d.invoice_number, 50)) problems.push('מספר חשבונית חסר');
  if (!reportingDateOf(d.invoice_date)) problems.push('תאריך חשבונית חסר או לא תקין');
  if (!clean(d.supplier_name, 100)) problems.push('שם ספק חסר');
  const split = vatSplit(d);
  if (!split) problems.push('סכום חסר');
  else if (split.vat > split.amount) problems.push('סכום המע"מ גדול מהסכום הכולל');
  if (!mapping.expenseAccount) problems.push('סיווג חשבונאי חסר (אין קטגוריית הוצאה ממופה)');
  return problems;
}

/** The POST /expenses body. Assumes morningValidationProblems() returned nothing. */
export function toMorningExpense(invoice: ExportInvoice, mapping: InvoiceMapping, options: MappingOptions): MorningExpenseRequest {
  const d = invoice.data;
  const date = d.invoice_date ?? '';
  const split = vatSplit(d) ?? { amount: 0, vat: 0 };
  const supplier: MorningSupplier = { name: clean(d.supplier_name, 100), add: true };
  const taxId = digits(d.supplier_vat_id);
  if (taxId) supplier.taxId = taxId;
  if (!mapping.supplierAccountIsFallback && mapping.supplierAccount) supplier.accountingKey = mapping.supplierAccount;
  const allocation = digits(d.allocation_number);
  const description = clean(
    d.expense_category || d.line_items?.find((li) => li.description)?.description || d.supplier_name,
    200
  );

  return {
    documentType: morningDocumentType(invoice, options),
    number: clean(d.invoice_number, 50),
    date,
    reportingDate: reportingDateOf(date) ?? '',
    currency: 'ILS',
    currencyRate: 1,
    amount: split.amount,
    vat: split.vat,
    description,
    remarks: morningRemarks(invoice.id),
    ...(allocation ? { allocationNumber: allocation } : {}),
    supplier,
    accountingClassification: { key: mapping.expenseAccount ?? '' },
    active: true,
  };
}

/** Search window around the invoice date (Morning's own date may differ by a few days). */
export const SEARCH_WINDOW_DAYS = 7;

export function toMorningSearch(invoice: ExportInvoice, page = 1, pageSize = 50): MorningSearchRequest | null {
  const d = invoice.data;
  const number = clean(d.invoice_number, 50);
  if (!number || !reportingDateOf(d.invoice_date)) return null;
  const date = d.invoice_date as string;
  // No supplierName filter: Morning may hold the supplier under a slightly different name; the
  // supplier is matched client-side (tax id first) in isSameExpense.
  return {
    number,
    fromDate: shiftDate(date, -SEARCH_WINDOW_DAYS),
    toDate: shiftDate(date, SEARCH_WINDOW_DAYS),
    page,
    pageSize,
  };
}

function normName(name: string | null | undefined): string {
  return (name ?? '').replace(/["'״׳.,\-]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Whether a Morning expense is this invoice: same number, same supplier (tax id when both have
 * one, else name), same document type when Morning reports one, and not deleted (status 100).
 */
export function isSameExpense(item: MorningExpense, invoice: ExportInvoice, documentType: MorningDocumentType): boolean {
  if (!item || typeof item.id !== 'string' || !item.id) return false;
  if (item.status === 100) return false;
  const d = invoice.data;
  if (String(item.number ?? '').trim() !== clean(d.invoice_number, 50)) return false;
  if (typeof item.documentType === 'number' && item.documentType !== documentType) return false;
  const ourTax = digits(d.supplier_vat_id);
  const theirTax = digits(item.supplier?.taxId === undefined ? null : String(item.supplier.taxId));
  if (ourTax && theirTax) return ourTax === theirTax;
  return normName(item.supplier?.name) !== '' && normName(item.supplier?.name) === normName(d.supplier_name);
}
