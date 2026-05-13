export type InvoiceStatus = 'processing' | 'review' | 'approved' | 'exported' | 'error';

export type MappingType = 'supplier' | 'category';

export interface FieldBbox {
  x1: number; y1: number; x2: number; y2: number; // 0–1, אחוזי גודל התמונה
}

export interface ValidationFlags {
  math_ok: boolean;
  vat_id_ok: boolean;
  fields_missing: string[];
  warnings?: string[];
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
  validation_flags: ValidationFlags;
  bboxes?: BboxMap;
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
