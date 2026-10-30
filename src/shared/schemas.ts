import { z } from 'zod';
import { MAX_LINE_ITEMS } from '@/shared/lineItems';

export const FieldBboxSchema = z.object({
  x1: z.number(),
  y1: z.number(),
  x2: z.number(),
  y2: z.number(),
});

export const BboxMapSchema = z.object({
  supplier_name: FieldBboxSchema.optional(),
  supplier_vat_id: FieldBboxSchema.optional(),
  invoice_number: FieldBboxSchema.optional(),
  invoice_date: FieldBboxSchema.optional(),
  amount_before_vat: FieldBboxSchema.optional(),
  vat_amount: FieldBboxSchema.optional(),
  total_amount: FieldBboxSchema.optional(),
  expense_category: FieldBboxSchema.optional(),
  allocation_number: FieldBboxSchema.optional(),
});

export const FieldConfidenceMapSchema = z.object({
  supplier_name: z.number().min(0).max(1).optional(),
  supplier_vat_id: z.number().min(0).max(1).optional(),
  invoice_number: z.number().min(0).max(1).optional(),
  invoice_date: z.number().min(0).max(1).optional(),
  amount_before_vat: z.number().min(0).max(1).optional(),
  vat_amount: z.number().min(0).max(1).optional(),
  total_amount: z.number().min(0).max(1).optional(),
  expense_category: z.number().min(0).max(1).optional(),
  allocation_number: z.number().min(0).max(1).optional(),
});

export const LineItemSchema = z.object({
  description: z.string().nullable(),
  quantity: z.number().nullable(),
  unit_price: z.number().nullable(),
  line_total: z.number().nullable(),
  vat_exempt: z.boolean().optional(),
});

export const VatIdSourcesSchema = z.object({
  invoice: z.string().nullable(),
  supplier_table: z.string().nullable(),
  web_search: z.string().nullable(),
});

export const DuplicateMatchSchema = z.object({
  invoice_id: z.string(),
  reason: z.enum(['same_file', 'same_number', 'fuzzy']),
  file_name: z.string().nullable().optional(),
  invoice_number: z.string().nullable().optional(),
  invoice_date: z.string().nullable().optional(),
  total_amount: z.number().nullable().optional(),
  status: z.enum(['processing', 'review', 'approved', 'exported', 'error', 'rejected', 'returned']).nullable().optional(),
});

export const ValidationResultSchema = z.object({
  math_ok: z.boolean(),
  vat_id_ok: z.boolean(),
  fields_missing: z.array(z.string()),
  duplicate_found: z.boolean(),
  duplicate_matches: z.array(DuplicateMatchSchema).optional(),
  rule_violations: z.array(z.string()),
  warnings: z.array(z.string()),
  requires_manual_review: z.boolean(),
  not_an_invoice: z.boolean().optional(),
  allocation_required: z.boolean().optional(),
  line_items_sum_ok: z.boolean().nullable().optional(),
  mixed_vat: z.boolean().optional(),
  vat_id_sources: VatIdSourcesSchema.optional(),
  auto_approved: z.boolean().optional(),
  auto_approve_blockers: z.array(z.string()).optional(),
});

export const SupplierRuleTraceSchema = z.object({
  mapping_id: z.string().nullable(),
  applied: z.object({
    supplier_name: z.string().optional(),
    expense_category: z.string().optional(),
  }),
  applied_at: z.string(),
});

export const SplitDocumentSchema = z.object({
  start_page: z.number().int().min(1),
  end_page: z.number().int().min(1),
  confidence: z.number().min(0).max(1).nullable(),
  reason: z.string().nullable(),
});

export const SplitSuggestionSchema = z.object({
  page_count: z.number().int().min(1),
  documents: z.array(SplitDocumentSchema).min(1),
  confidence: z.number().min(0).max(1),
  source: z.enum(['page_markers', 'llm']),
  detected_at: z.string(),
});

export const ExtractedDataSchema = z.object({
  supplier_name: z.string().nullable(),
  supplier_vat_id: z.string().nullable(),
  invoice_number: z.string().nullable(),
  invoice_date: z.string().nullable(),
  amount_before_vat: z.number().nullable(),
  vat_amount: z.number().nullable(),
  total_amount: z.number().nullable(),
  expense_category: z.string().nullable(),
  allocation_number: z.string().nullable().optional(),
  line_items: z.array(LineItemSchema).max(MAX_LINE_ITEMS).nullable().optional(),
  field_confidence: FieldConfidenceMapSchema.optional(),
  validation_flags: ValidationResultSchema.optional(),
  bboxes: BboxMapSchema.optional(),
  supplier_rule: SupplierRuleTraceSchema.nullable().optional(),
  split_suggestion: SplitSuggestionSchema.nullable().optional(),
});

export const TenantRulesSchema = z.object({
  maxAmountForAutoApprove: z.number().default(1000),
  requireVatId: z.boolean().default(true),
  requireInvoiceDate: z.boolean().default(true),
  requireExpenseCategory: z.boolean().default(true),
  allowedExpenseCategories: z.array(z.string()).default([
    'ציוד משרדי',
    'שכ"ד',
    'תקשורת',
    'שיווק ופרסום',
    'נסיעות',
    'אחזקה',
    'שירותים מקצועיים',
    'חשמל ומים',
    'אחר'
  ]),
  duplicateInvoiceCheck: z.boolean().default(true),
});

export const InvoiceSchema = z.object({
  id: z.string().uuid(),
  client_id: z.string().uuid(),
  file_url: z.string().url(),
  file_name: z.string(),
  status: z.enum(['processing', 'review', 'approved', 'exported', 'error', 'rejected', 'returned']),
  extracted_data: ExtractedDataSchema.nullable(),
  validated_data: ExtractedDataSchema.nullable(),
  ai_confidence: z.number().nullable(),
  error_message: z.string().nullable(),
  exported_at: z.string().nullable(),
  file_hash: z.string().nullable().optional(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const OcrMetadataSchema = z.object({
  pageCount: z.number(),
  detectedLanguages: z.array(z.string()),
  confidence: z.number(),
});

export const CostMetricsSchema = z.object({
  ocrOpCount: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  estimatedCostUsd: z.number(),
});


// ── Bank statement matching (/api/bank) ───────────────────────────────
// Ids are plain strings: the local mock DB doesn't generate UUIDs.

/** numeric(14,2): |amount| must stay below 10^12. */
export const MAX_BANK_AMOUNT = 999_999_999_999.99;

/** YYYY-MM-DD that is a real calendar date (no 2026-02-30 / 2026-13-45), years 1900-2200. */
export function isRealIsoDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (year < 1900 || year > 2200) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

export const NormalizedBankRowSchema = z.object({
  txn_date: z.string({ message: 'חסר תאריך' }).refine(isRealIsoDate, { message: 'תאריך לא תקין' }),
  description: z.string({ message: 'תיאור לא תקין' }).max(500, { message: 'התיאור ארוך מדי (עד 500 תווים)' }),
  amount: z
    .number({ message: 'סכום לא תקין' })
    .finite({ message: 'סכום לא תקין' })
    .refine((n) => Math.abs(n) <= MAX_BANK_AMOUNT, { message: 'הסכום גדול מדי' }),
  reference: z.string({ message: 'אסמכתא לא תקינה' }).max(100, { message: 'האסמכתא ארוכה מדי (עד 100 תווים)' }).nullable(),
});

export const MAX_BANK_IMPORT_ROWS = 20000;

export const BankImportSchema = z.object({
  clientId: z.string({ message: 'חסר לקוח' }).min(1, { message: 'חסר לקוח' }),
  accountLabel: z
    .string({ message: 'חסר שם חשבון / כרטיס' })
    .trim()
    .min(1, { message: 'חסר שם חשבון / כרטיס' })
    .max(100, { message: 'שם החשבון ארוך מדי (עד 100 תווים)' }),
  fileName: z.string().max(255, { message: 'שם הקובץ ארוך מדי' }).nullable().optional(),
  rows: z
    .array(NormalizedBankRowSchema, { message: 'חסרות שורות לייבוא' })
    .min(1, { message: 'אין שורות לייבוא' })
    .max(MAX_BANK_IMPORT_ROWS, { message: `ניתן לייבא עד ${MAX_BANK_IMPORT_ROWS.toLocaleString('en-US')} שורות בפעם אחת` }),
});

/**
 * First validation problem of a bank import as a Hebrew message that names the row
 * (1-based, as in the statement preview), e.g. "שורה 551: תאריך לא תקין".
 */
export function bankImportErrorMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'נתוני הייבוא אינם תקינים';
  const [first, index] = issue.path;
  if (first === 'rows' && typeof index === 'number') return `שורה ${index + 1}: ${issue.message}`;
  return issue.message;
}

export const BankActionSchema = z.discriminatedUnion('action', [
  // force: the reviewer confirmed matching an invoice whose total differs from the charge.
  z.object({ action: z.literal('match'), invoiceId: z.string().min(1), force: z.boolean().optional() }),
  z.object({ action: z.literal('unmatch') }),
  z.object({ action: z.literal('ignore') }),
  z.object({ action: z.literal('restore') }),
]);
