import { z } from 'zod';

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
  status: z.enum(['processing', 'review', 'approved', 'exported', 'error', 'rejected']).nullable().optional(),
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
  vat_id_sources: VatIdSourcesSchema.optional(),
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
  validation_flags: ValidationResultSchema.optional(),
  bboxes: BboxMapSchema.optional(),
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
  status: z.enum(['processing', 'review', 'approved', 'exported', 'error']),
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

