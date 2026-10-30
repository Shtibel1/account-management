import type { SplitSuggestion } from '@/shared/documentSplit';
import type { FewShotExample } from '@/shared/fewshot';

export type InvoiceStatus = 'processing' | 'review' | 'approved' | 'exported' | 'error' | 'rejected';

/** Channel an invoice arrived through (invoices.source). */
export type InvoiceSource = 'upload' | 'email' | 'whatsapp';

export type MappingType = 'supplier' | 'category';

export interface FieldBbox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  page?: number;
}

export type BboxMap = Partial<Record<
  'supplier_name' | 'supplier_vat_id' | 'invoice_number' |
  'invoice_date' | 'amount_before_vat' | 'vat_amount' | 'total_amount' | 'expense_category' |
  'allocation_number',
  FieldBbox
>>;

/** Main fields the extraction reports a 0-1 confidence for. */
export type ConfidenceField =
  'supplier_name' | 'supplier_vat_id' | 'invoice_number' | 'invoice_date' |
  'amount_before_vat' | 'vat_amount' | 'total_amount' | 'expense_category' | 'allocation_number';

export type FieldConfidenceMap = Partial<Record<ConfidenceField, number>>;

export interface LineItem {
  description: string | null;
  quantity: number | null;
  unit_price: number | null;
  line_total: number | null;
  vat_exempt?: boolean;
}

export interface ExtractedData {
  supplier_name: string | null;
  supplier_vat_id: string | null;
  invoice_number: string | null;
  invoice_date: string | null;        // YYYY-MM-DD
  amount_before_vat: number | null;
  vat_amount: number | null;
  total_amount: number | null;
  expense_category: string | null;
  allocation_number?: string | null;  // ITA מספר הקצאה
  bank_name?: string | null;
  bank_branch_code?: string | null;
  bank_branch_name?: string | null;
  bank_account?: string | null;
  line_items?: LineItem[] | null;           // max MAX_LINE_ITEMS (shared/lineItems.ts)
  field_confidence?: FieldConfidenceMap;     // model confidence per field, absent on old records
  validation_flags?: ValidationResult;
  bboxes?: BboxMap;
  split_suggestion?: SplitSuggestion | null; // file looks like several documents (set by the pipeline)
  supplier_rule?: SupplierRuleTrace | null; // validated_data only: what the supplier rule filled in
}

// Fields a supplier rule (account_mappings row of type 'supplier') may fill on an invoice.
export type SupplierRuleField = 'supplier_name' | 'expense_category';

/**
 * Trace of the supplier rule applied to validated_data. Lets a later re-apply tell rule-filled
 * values apart from explicit reviewer edits (precedence: reviewer edit > supplier rule > AI).
 */
export interface SupplierRuleTrace {
  mapping_id: string | null;
  applied: Partial<Record<SupplierRuleField, string>>;
  applied_at: string;
}

export interface TenantRules {
  maxAmountForAutoApprove: number;
  requireVatId: boolean;
  requireInvoiceDate: boolean;
  requireExpenseCategory: boolean;
  allowedExpenseCategories: string[];
  duplicateInvoiceCheck: boolean;
}

export interface VatIdSources {
  invoice: string | null;
  supplier_table: string | null;
  web_search: string | null;
}

// Why another invoice is suspected to be the same document, strongest first.
export type DuplicateReason = 'same_file' | 'same_number' | 'fuzzy';

export interface DuplicateMatch {
  invoice_id: string;
  reason: DuplicateReason;
  // Snapshot of the other invoice for display, so the review UI needs no extra query
  file_name?: string | null;
  invoice_number?: string | null;
  invoice_date?: string | null;
  total_amount?: number | null;
  status?: InvoiceStatus | null;
}

export interface ValidationResult {
  math_ok: boolean;
  vat_id_ok: boolean;
  fields_missing: string[];
  duplicate_found: boolean;
  duplicate_matches?: DuplicateMatch[];
  rule_violations: string[];
  warnings: string[];
  requires_manual_review: boolean;
  not_an_invoice?: boolean;
  allocation_required?: boolean;
  line_items_sum_ok?: boolean | null;  // null = no line items / nothing to compare
  mixed_vat?: boolean;
  vat_id_sources?: VatIdSources;
  auto_approved?: boolean;            // skipped manual review via the supplier auto-approve opt-in
  auto_approve_blockers?: string[];   // supplier is opted in, but these checks sent it to review
}

export interface Client {
  id: string;
  name: string;
  vat_account: string;
  /** Local part of the client's inbound email address (<alias>@INBOUND_EMAIL_DOMAIN). */
  inbound_alias?: string | null;
  /** Owning organization (bookkeeping office); see docs/auth.md. Absent in the local mock DB. */
  org_id?: string;
  created_at: string;
}

/** A phone number allowed to send documents for a client over WhatsApp (E.164). */
export interface ClientContact {
  id: string;
  client_id: string;
  phone: string;
  name: string | null;
  created_at: string;
}

export interface AccountMapping {
  id: string;
  client_id: string;
  mapping_type: MappingType;
  key: string;
  account_code: string;
  supplier_number?: string | null;
  vat_id?: string | null;
  expense_category?: string | null;
}

// Per client+supplier auto-approve opt-in (table supplier_automation), keyed by normalized VAT ID.
export type AutoApproveDisabledReason = 'manual' | 'corrections';

export interface SupplierAutomation {
  id: string;
  client_id: string;
  supplier_vat_id: string;
  auto_approve: boolean;
  enabled_at: string | null;
  disabled_at: string | null;
  disabled_reason: AutoApproveDisabledReason | null;
  disabled_by_invoice_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface SupplierEligibility {
  supplier_vat_id: string;
  reviewed_count: number;  // human-reviewed invoices (reviewed_at set)
  clean_streak: number;    // most recent reviewed invoices in a row with zero corrections
  eligible: boolean;       // last AUTO_APPROVE_HISTORY_SIZE reviews were all correction-free
}

export interface SupplierAutomationStatus extends SupplierEligibility {
  auto_approve: boolean;
  disabled_reason: AutoApproveDisabledReason | null;
  disabled_at: string | null;
}

export interface Invoice {
  id: string;
  client_id: string;
  file_url: string;
  file_name: string;
  status: InvoiceStatus;
  source?: InvoiceSource;
  /** Sender address / phone for email and WhatsApp documents. */
  source_sender?: string | null;
  extracted_data: ExtractedData | null;
  validated_data: ExtractedData | null;
  ai_confidence: number | null;
  error_message: string | null;
  exported_at: string | null;
  reviewed_at?: string | null;
  ocr_text?: string | null;            // raw OCR text, input for per-supplier few-shot examples
  fewshot_example_count?: number | null;
  fewshot_example_ids?: string[] | null;
  file_hash?: string | null;          // SHA-256 (hex) of the stored file bytes
  created_at: string;
  updated_at: string;
}

export interface DuplicateDismissal {
  id: string;
  client_id: string;
  invoice_id: string;
  other_invoice_id: string;
  dismissed_at: string;
}

export interface ExportRow {
  invoice_id: string;
  date: string;           // DDMMYYYY
  supplier_account: string;
  expense_account: string;
  vat_account: string;
  amount_before_vat: number;
  vat_amount: number;
}

export interface MissingMapping {
  invoice_id: string;
  file_name: string;
  supplier_name: string | null;
  expense_category: string | null;
  missing: ('supplier' | 'category')[];
}

export interface OcrMetadata {
  pageCount: number;
  detectedLanguages: string[];
  confidence: number;
}

export interface OcrWord {
  text: string;
  bbox: { x1: number; y1: number; x2: number; y2: number };
  page: number;
}

export interface CostMetrics {
  ocrOpCount: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

// LangGraph state model
export interface PipelineState {
  invoiceId: string;
  fileUrl: string;
  mimeType: string;
  tenantId: string;
  tenantRules: TenantRules | null;
  rawOcrText: string | null;
  ocrMetadata: OcrMetadata | null;
  ocrWords?: OcrWord[];
  extractedData: ExtractedData | null;
  validationResult: ValidationResult | null;
  supplierRule?: SupplierRuleTrace | null;
  retryCount: number;
  status: InvoiceStatus;
  error: string | null;
  costMetrics: CostMetrics;
  useVisionFallback: boolean;
  splitSuggestion?: SplitSuggestion | null;
  /** Per-supplier few-shot lookup, loaded once per run (null = not loaded yet). */
  fewShot?: FewShotLookupState | null;
  /** Past invoices included as examples in the latest extraction (null = extraction didn't run). */
  fewShotExampleIds?: string[] | null;
}

export interface FewShotLookupState {
  examples: FewShotExample[];
  supplierVatId: string | null;
}


// ── Bank / credit-card statement matching ─────────────────────────────

export type BankMatchStatus = 'unmatched' | 'auto' | 'manual' | 'ignored';

export interface BankTransaction {
  id: string;
  client_id: string;
  account_label: string;
  txn_date: string;                  // YYYY-MM-DD
  description: string;
  amount: number;                    // negative = debit (money out)
  reference: string | null;
  matched_invoice_id: string | null;
  match_status: BankMatchStatus;
  rejected_invoice_ids?: string[] | null;
  dedupe_key: string;
  import_batch_id: string;
  source_file?: string | null;
  created_at: string;
}

/** One statement line after column mapping + normalization, before it is stored. */
export interface NormalizedBankRow {
  txn_date: string;                  // YYYY-MM-DD
  description: string;
  amount: number;                    // negative = debit
  reference: string | null;
}

/** The invoice fields bank matching needs (from validated_data, falling back to extracted_data). */
export interface MatchableInvoice {
  id: string;
  file_name: string;
  status: InvoiceStatus;
  supplier_name: string | null;
  invoice_number: string | null;
  invoice_date: string | null;       // YYYY-MM-DD
  total_amount: number | null;
}
