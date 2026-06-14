export type InvoiceStatus = 'processing' | 'review' | 'approved' | 'exported' | 'error' | 'rejected';

export type MappingType = 'supplier' | 'category';

export interface FieldBbox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export type BboxMap = Partial<Record<
  'supplier_name' | 'supplier_vat_id' | 'invoice_number' |
  'invoice_date' | 'amount_before_vat' | 'vat_amount' | 'total_amount' | 'expense_category',
  FieldBbox
>>;

export interface ExtractedData {
  supplier_name: string | null;
  supplier_vat_id: string | null;
  invoice_number: string | null;
  invoice_date: string | null;        // YYYY-MM-DD
  amount_before_vat: number | null;
  vat_amount: number | null;
  total_amount: number | null;
  expense_category: string | null;
  bank_name?: string | null;
  bank_branch_code?: string | null;
  bank_branch_name?: string | null;
  bank_account?: string | null;
  validation_flags?: ValidationResult;
  bboxes?: BboxMap;
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

export interface ValidationResult {
  math_ok: boolean;
  vat_id_ok: boolean;
  fields_missing: string[];
  duplicate_found: boolean;
  rule_violations: string[];
  warnings: string[];
  requires_manual_review: boolean;
  not_an_invoice?: boolean;
  vat_id_sources?: VatIdSources;
}

export interface Client {
  id: string;
  name: string;
  vat_account: string;
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

export interface Invoice {
  id: string;
  client_id: string;
  file_url: string;
  file_name: string;
  status: InvoiceStatus;
  extracted_data: ExtractedData | null;
  validated_data: ExtractedData | null;
  ai_confidence: number | null;
  error_message: string | null;
  exported_at: string | null;
  created_at: string;
  updated_at: string;
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
  extractedData: ExtractedData | null;
  validationResult: ValidationResult | null;
  retryCount: number;
  status: InvoiceStatus;
  error: string | null;
  costMetrics: CostMetrics;
  useVisionFallback: boolean;
}

