import type { ExportInvoice, InvoiceMapping } from '@/integrations/types';

/**
 * iCount (API v3) mapping: our invoice -> the body of expense/create (pure, no network).
 *
 * The supplier is resolved at export time (supplier/get_list by vat_id, else supplier/add), so the
 * payload carries the supplier lookup next to the expense body without supplier_id.
 */

export type IcountAuthMode = 'token' | 'login';
export type OnOff = 'on' | 'off';

/** Validated config (form values are strings; empty fields are absent). */
export interface IcountConfig {
  /** Default 'token'. */
  authMode?: IcountAuthMode;
  /** API token (Authorization: Bearer). */
  apiToken?: string;
  /** Legacy login (auth/login -> sid). */
  cid?: string;
  user?: string;
  pass?: string;
  /** iCount expense_type_id used when the category does not give one. */
  defaultExpenseTypeId?: string;
  /** 'on': the category's account code (account_mappings) IS the iCount expense_type_id. Default off. */
  expenseTypeFromCategory?: OnOff;
  /** expense_doctype for invoices. Default 'invoice'. */
  docType?: string;
  /** expense_doctype for credit notes (negative totals). Default 'refund'. */
  creditDocType?: string;
  /** Safety toggle: create drafts only (is_draft=true). Default ON; only 'off' disables it. */
  draftOnly?: OnOff;
}

export const DEFAULT_DOC_TYPE = 'invoice';
export const DEFAULT_CREDIT_DOC_TYPE = 'refund';

/** Body of expense/create without supplier_id (added once the supplier is resolved). */
export interface IcountExpenseBody {
  expense_type_id: number | null;
  expense_doctype: string;
  expense_docnum: string;
  /** Manual VAT mode: expense_sum is the amount BEFORE VAT, VAT is given separately. */
  adv_expense: true;
  expense_sum: number;
  expense_manual_vat?: number;
  manual_no_vat?: true;
  currency_code: 'ILS';
  invoice_date: string | null;
  vat_date: string | null;
  allocation_number?: number;
  is_draft: boolean;
  /** Traceability back to our invoice. */
  comment: string;
}

export interface IcountExportPayload {
  supplier: { name: string | null; vat_id: string | null };
  expense: IcountExpenseBody;
  /** True for a credit note (amounts are sent as absolute values with the credit doctype). */
  credit_note: boolean;
  /** Problems that block the export (shown to the user; also visible in dry runs). */
  problems: string[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function isDraftOnly(config: IcountConfig): boolean {
  return config.draftOnly !== 'off';
}

/** Digits only, leading zeros dropped (iCount stores vat_id as an int). Null when empty. */
export function normalizeVatId(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const digits = String(value).replace(/\D/g, '').replace(/^0+/, '');
  return digits || null;
}

export function isCreditNote(invoice: ExportInvoice): boolean {
  const d = invoice.data;
  const ref = d.total_amount ?? d.amount_before_vat;
  return typeof ref === 'number' && ref < 0;
}

/** Amount before VAT and VAT, as positive numbers (credit notes are flagged separately). */
export function vatSplit(invoice: ExportInvoice): { net: number; vat: number } | null {
  const { amount_before_vat: before, vat_amount: vat, total_amount: total } = invoice.data;
  let net: number | null = typeof before === 'number' ? before : null;
  let v: number | null = typeof vat === 'number' ? vat : null;
  if (net === null && typeof total === 'number' && v !== null) net = total - v;
  if (v === null && net !== null && typeof total === 'number') v = total - net;
  if (net === null) return null;
  return { net: round2(Math.abs(net)), vat: round2(Math.abs(v ?? 0)) };
}

/** expense_type_id for the invoice: the category's account code (when enabled and numeric), else the default. */
export function resolveExpenseTypeId(config: IcountConfig, mapping: InvoiceMapping): number | null {
  if (config.expenseTypeFromCategory === 'on' && mapping.expenseAccount && /^\d{1,10}$/.test(mapping.expenseAccount.trim())) {
    return Number(mapping.expenseAccount.trim());
  }
  if (config.defaultExpenseTypeId && /^\d{1,10}$/.test(config.defaultExpenseTypeId.trim())) {
    return Number(config.defaultExpenseTypeId.trim());
  }
  return null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function docTypeFor(config: IcountConfig, credit: boolean): string {
  return credit ? (config.creditDocType?.trim() || DEFAULT_CREDIT_DOC_TYPE) : (config.docType?.trim() || DEFAULT_DOC_TYPE);
}

/** Invoice-only checks (no config needed); used by validateInvoice. */
export function invoiceProblems(invoice: ExportInvoice): string[] {
  const d = invoice.data;
  const problems: string[] = [];
  if (!d.invoice_number?.trim()) problems.push('מספר חשבונית חסר');
  if (!d.invoice_date || !ISO_DATE.test(d.invoice_date)) problems.push('תאריך חשבונית חסר או לא תקין');
  if (!vatSplit(invoice)) problems.push('סכום לפני מע"מ חסר');
  if (!d.supplier_name?.trim() && !normalizeVatId(d.supplier_vat_id)) problems.push('שם ספק או ח.פ. חסרים');
  const alloc = d.allocation_number?.trim();
  if (alloc && !/^\d{1,15}$/.test(alloc)) problems.push('מספר הקצאה לא תקין');
  return problems;
}

export function toIcountPayload(invoice: ExportInvoice, mapping: InvoiceMapping, config: IcountConfig): IcountExportPayload {
  const d = invoice.data;
  const problems = invoiceProblems(invoice);
  const expenseTypeId = resolveExpenseTypeId(config, mapping);
  if (expenseTypeId === null) problems.push('סוג הוצאה ב-iCount לא הוגדר (מזהה ברירת מחדל או קוד קטגוריה)');

  const credit = isCreditNote(invoice);
  const split = vatSplit(invoice) ?? { net: 0, vat: 0 };
  const date = d.invoice_date && ISO_DATE.test(d.invoice_date) ? d.invoice_date : null;
  const alloc = d.allocation_number?.trim();

  const expense: IcountExpenseBody = {
    expense_type_id: expenseTypeId,
    expense_doctype: docTypeFor(config, credit),
    expense_docnum: (d.invoice_number ?? '').trim(),
    adv_expense: true,
    expense_sum: split.net,
    ...(split.vat > 0 ? { expense_manual_vat: split.vat } : { manual_no_vat: true as const }),
    currency_code: 'ILS',
    invoice_date: date,
    vat_date: date,
    ...(alloc && /^\d{1,15}$/.test(alloc) ? { allocation_number: Number(alloc) } : {}),
    is_draft: isDraftOnly(config),
    comment: `invoice-scan:${invoice.id}`,
  };

  return {
    supplier: { name: d.supplier_name?.trim() || null, vat_id: normalizeVatId(d.supplier_vat_id) },
    expense,
    credit_note: credit,
    problems,
  };
}
