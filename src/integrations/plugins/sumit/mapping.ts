import type { ExportInvoice, InvoiceMapping } from '@/integrations/types';

/**
 * SUMIT (app.sumit.co.il) expense mapping - pure.
 * Spec: https://app.sumit.co.il/swagger/v1/swagger.json, POST /accounting/documents/addexpense/.
 * See README.md in this folder for the VAT / credit-note / allocation-number assumptions.
 */

export const SUMIT_BASE_URL = 'https://api.sumit.co.il';

/** Accounting_Typed_CustomerSearchMode (enums are sent as numbers, like the spec's examples). */
export const SUPPLIER_SEARCH_MODE = { Automatic: 0, None: 1, ExternalIdentifier: 2, Name: 3, CompanyNumber: 4 } as const;
/** Accounting_Typed_ExpenseItemSearchMode. */
export const ITEM_SEARCH_MODE = { Automatic: 0, None: 1, ExternalIdentifier: 2, Name: 3 } as const;

/**
 * Accounting_Typed_DocumentType values an addexpense call can produce: ExpenseInvoiceReceipt (15),
 * ExpenseInvoice (16), ExpenseReceipt (17) and their credit variants (19, 20, 21).
 */
export const EXPENSE_DOCUMENT_TYPES = [15, 16, 17, 19, 20, 21] as const;

export type SumitDocumentMode = 'draft' | 'final';
export type SumitAmountMode = 'gross' | 'net';
export type SumitItemMatch = 'name' | 'externalId' | 'id';

/** Stored config (select values are strings; unset selects fall back to the defaults below). */
export interface SumitConfig {
  companyId: string;
  apiKey: string;
  documentMode?: SumitDocumentMode;
  amountMode?: SumitAmountMode;
  itemMatch?: SumitItemMatch;
  defaultItem?: string;
  attachFile?: 'yes' | 'no';
}

export interface SumitSettings {
  /** Safety toggle: expenses are created as drafts unless the office explicitly chose "final". */
  isDraft: boolean;
  amountMode: SumitAmountMode;
  itemMatch: SumitItemMatch;
  defaultItem: string | null;
  attachFile: boolean;
}

export function sumitSettings(config: Partial<SumitConfig>): SumitSettings {
  return {
    isDraft: config.documentMode !== 'final',
    amountMode: config.amountMode === 'net' ? 'net' : 'gross',
    itemMatch: config.itemMatch === 'externalId' || config.itemMatch === 'id' ? config.itemMatch : 'name',
    defaultItem: config.defaultItem?.trim() || null,
    attachFile: config.attachFile !== 'no',
  };
}

export interface SumitSupplier {
  Name: string;
  CompanyNumber: string | null;
  SearchMode: number;
  /** Only sent (true) for an invoice without VAT; see README. */
  NoVAT?: true;
}

export interface SumitExpenseItemRef {
  ID?: number;
  Name?: string;
  ExternalIdentifier?: string;
  SearchMode: number;
}

export interface SumitExpenseLine {
  Item: SumitExpenseItemRef;
  Amount: number;
}

/** Accounting_Documents_AddExpense_Request without Credentials (added by the client at send time). */
export interface SumitExpensePayload {
  Supplier: SumitSupplier;
  ExpenseNumber: string;
  Date: string;
  Lines: SumitExpenseLine[];
  Description: string;
  IsDraft: boolean;
  ExpenseFilename: string | null;
  /** Base64 file; filled by exportInvoice (null in buildPayload / dry runs). */
  ExpenseFile: string | null;
}

export interface SumitAmounts {
  gross: number;
  net: number;
  vat: number;
  isCredit: boolean;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Gross / net / VAT of the invoice, filling one missing value from the other two. Null if unknown. */
export function sumitAmounts(invoice: ExportInvoice): SumitAmounts | null {
  const d = invoice.data;
  const before = num(d.amount_before_vat);
  const vatIn = num(d.vat_amount);
  const total = num(d.total_amount);
  const gross = total ?? (before !== null && vatIn !== null ? before + vatIn : null);
  const net = before ?? (total !== null && vatIn !== null ? total - vatIn : null);
  if (gross === null && net === null) return null;
  const vat = vatIn ?? (gross !== null && net !== null ? gross - net : 0);
  const g = gross ?? (net as number) + vat;
  const n = net ?? g - vat;
  return { gross: round2(g), net: round2(n), vat: round2(vat), isCredit: g < 0 || n < 0 };
}

/** Marker in the expense description (bracketed, so "inv-1" never matches "inv-10"): lets findExisting recognise a document we created. */
export function sumitInvoiceMarker(invoiceId: string): string {
  return `[invoice-scan:${invoiceId}]`;
}

export function normalizeDocNumber(value: unknown): string {
  return String(value ?? '').trim().replace(/\s+/g, '').replace(/^0+(?=.)/, '').toLowerCase();
}

export function normalizeName(value: unknown): string {
  return String(value ?? '')
    .replace(/["'`׳״.,\-()]/g, ' ')
    .replace(/(^|\s)(בע\s*מ|ltd|inc)(?=\s|$)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidIsoDate(value: string | null | undefined): value is string {
  if (!value || !ISO_DATE_RE.test(value)) return false;
  const t = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === value;
}

export function itemCodeFor(mapping: InvoiceMapping, settings: SumitSettings): string | null {
  return mapping.expenseAccount?.trim() || settings.defaultItem;
}

export function itemRef(code: string, settings: SumitSettings): SumitExpenseItemRef {
  if (settings.itemMatch === 'id') return { ID: Number(code), SearchMode: ITEM_SEARCH_MODE.Automatic };
  if (settings.itemMatch === 'externalId') return { ExternalIdentifier: code, SearchMode: ITEM_SEARCH_MODE.ExternalIdentifier };
  return { Name: code, SearchMode: ITEM_SEARCH_MODE.Name };
}

/**
 * Problems that block exporting this invoice to SUMIT (Hebrew). With `settings` null (validateInvoice
 * has no config) the amount mode defaults to gross and the expense-item checks are skipped.
 */
export function validateForSumit(invoice: ExportInvoice, mapping: InvoiceMapping, settings: SumitSettings | null): string[] {
  const d = invoice.data;
  const problems: string[] = [];
  if (!d.supplier_name?.trim()) problems.push('שם ספק');
  if (!d.invoice_number?.trim()) problems.push('מספר חשבונית');
  if (!isValidIsoDate(d.invoice_date)) problems.push('תאריך חשבונית');
  const amounts = sumitAmounts(invoice);
  if (!amounts) {
    problems.push('סכום');
  } else {
    const amount = settings?.amountMode === 'net' ? amounts.net : amounts.gross;
    if (amount === 0) problems.push('סכום (0)');
  }
  if (!settings) return problems;
  const code = itemCodeFor(mapping, settings);
  if (!code) problems.push('סעיף הוצאה ב-SUMIT (מיפוי קטגוריה או סעיף ברירת מחדל)');
  else if (settings.itemMatch === 'id' && !/^\d{1,15}$/.test(code)) problems.push(`מזהה סעיף הוצאה לא מספרי: ${code}`);
  return problems;
}

function descriptionFor(invoice: ExportInvoice): string {
  const parts: string[] = [];
  const allocation = invoice.data.allocation_number?.trim();
  if (allocation) parts.push(`מספר הקצאה: ${allocation}`);
  parts.push(sumitInvoiceMarker(invoice.id));
  return parts.join(' | ');
}

/**
 * Our invoice -> addexpense body (pure; call validateForSumit first).
 *   - one line: Item = the mapped expense account code (or the default item), Amount = the invoice
 *     total INCLUDING VAT ("gross", default) or before VAT ("net"), per the client's setting;
 *   - credit notes (negative amounts) are sent with a negative Amount;
 *   - the allocation number goes into Description (addexpense has no field for it).
 */
export function toSumitExpense(invoice: ExportInvoice, mapping: InvoiceMapping, settings: SumitSettings): SumitExpensePayload {
  const d = invoice.data;
  const amounts = sumitAmounts(invoice) ?? { gross: 0, net: 0, vat: 0, isCredit: false };
  const vatId = (d.supplier_vat_id ?? '').replace(/\D/g, '') || null;
  const supplier: SumitSupplier = {
    Name: (d.supplier_name ?? '').trim(),
    CompanyNumber: vatId,
    SearchMode: vatId ? SUPPLIER_SEARCH_MODE.CompanyNumber : SUPPLIER_SEARCH_MODE.Name,
  };
  if (amounts.vat === 0 && amounts.net !== 0) supplier.NoVAT = true;
  const code = itemCodeFor(mapping, settings) ?? '';
  return {
    Supplier: supplier,
    ExpenseNumber: (d.invoice_number ?? '').trim(),
    Date: d.invoice_date ?? '',
    Lines: [{ Item: itemRef(code, settings), Amount: settings.amountMode === 'net' ? amounts.net : amounts.gross }],
    Description: descriptionFor(invoice),
    IsDraft: settings.isDraft,
    ExpenseFilename: settings.attachFile ? invoice.fileName || 'invoice.pdf' : null,
    ExpenseFile: null,
  };
}

/** One document of /accounting/documents/list/ (fields we use). */
export interface SumitListedDocument {
  DocumentID?: number | null;
  Type?: number | string | null;
  Date?: string | null;
  CustomerName?: string | null;
  Description?: string | null;
  ExternalReference?: string | null;
  DocumentValue?: number | null;
  IsDraft?: boolean | null;
}

/**
 * Picks the SUMIT document that is this invoice (pure):
 *   1. our marker in the description (we created it), else
 *   2. same supplier invoice number (ExternalReference) AND (same supplier name OR same amount).
 */
export function matchExistingDocument(invoice: ExportInvoice, docs: SumitListedDocument[]): SumitListedDocument | null {
  const marker = sumitInvoiceMarker(invoice.id);
  const withId = docs.filter((doc) => typeof doc.DocumentID === 'number' && doc.DocumentID > 0);
  const byMarker = withId.find((doc) => typeof doc.Description === 'string' && doc.Description.includes(marker));
  if (byMarker) return byMarker;

  const number = normalizeDocNumber(invoice.data.invoice_number);
  if (!number) return null;
  const supplier = normalizeName(invoice.data.supplier_name);
  const amounts = sumitAmounts(invoice);
  const candidates = amounts ? [amounts.gross, amounts.net].map(Math.abs) : [];
  return withId.find((doc) => {
    if (normalizeDocNumber(doc.ExternalReference) !== number) return false;
    const sameName = !!supplier && normalizeName(doc.CustomerName) === supplier;
    const value = typeof doc.DocumentValue === 'number' ? Math.abs(doc.DocumentValue) : null;
    const sameAmount = value !== null && candidates.some((c) => Math.abs(c - value) < 0.011);
    return sameName || sameAmount;
  }) ?? null;
}

/** Date window for the duplicate lookup: the invoice date +- 1 day (timezone slack). */
export function lookupWindow(invoiceDate: string): { from: string; to: string } {
  const t = Date.parse(`${invoiceDate}T00:00:00Z`);
  const day = 24 * 60 * 60 * 1000;
  return {
    from: new Date(t - day).toISOString().slice(0, 10),
    to: new Date(t + day).toISOString().slice(0, 10),
  };
}
