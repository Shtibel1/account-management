import type { SupabaseClient } from '@supabase/supabase-js';
import type { ExtractedData } from '@/shared/types';
import { normalizeVatId, systemProposal } from '@/shared/supplierRules';

// Keep in sync with the field list in the field_accuracy view (supabase/migrations).
export const TRACKED_FIELDS = [
  'supplier_name',
  'supplier_vat_id',
  'invoice_number',
  'invoice_date',
  'amount_before_vat',
  'vat_amount',
  'total_amount',
  'expense_category',
  'allocation_number',
  'bank_name',
  'bank_branch_code',
  'bank_branch_name',
  'bank_account',
] as const;

export type TrackedField = (typeof TRACKED_FIELDS)[number];

export interface FieldCorrection {
  field: TrackedField;
  ai_value: string | number | null;
  corrected_value: string | number | null;
}

/** Money fields: compared as numbers (100 vs 100.00 vs '1,000' are the same value). */
const AMOUNT_FIELDS: ReadonlySet<TrackedField> = new Set(['amount_before_vat', 'vat_amount', 'total_amount']);

function normalizeText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  const s = String(value).trim().replace(/\s+/g, ' ');
  return s === '' ? null : s;
}

function normalizeAmount(value: unknown): string | number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
  const s = normalizeText(value);
  if (s === null) return null;
  const asNumber = Number(s.replace(/,/g, ''));
  if (/^-?[\d,]+(\.\d+)?$/.test(s) && Number.isFinite(asNumber)) return Math.round(asNumber * 100) / 100;
  return s;
}

/**
 * Normalizes a value so formatting-only differences don't count as corrections. Only amount fields
 * are normalized as numbers; identifiers (VAT ID, invoice / allocation / bank numbers) stay text,
 * so '05891' vs '5891' is a real correction and leading zeros are kept in the log.
 */
export function normalizeFieldValue(field: TrackedField, value: unknown): string | number | null {
  return AMOUNT_FIELDS.has(field) ? normalizeAmount(value) : normalizeText(value);
}

/** Returns the fields the reviewer changed relative to the AI extraction. */
export function diffCorrections(
  aiData: Partial<ExtractedData> | null | undefined,
  approvedData: Partial<ExtractedData> | null | undefined
): FieldCorrection[] {
  if (!aiData || !approvedData) return [];
  const corrections: FieldCorrection[] = [];
  for (const field of TRACKED_FIELDS) {
    // Partial payloads: a field the form didn't send was not corrected.
    if (!(field in approvedData)) continue;
    const ai = normalizeFieldValue(field, aiData[field]);
    const corrected = normalizeFieldValue(field, approvedData[field]);
    if (ai !== corrected) corrections.push({ field, ai_value: ai, corrected_value: corrected });
  }
  return corrections;
}

/**
 * Replaces the correction rows for an invoice (idempotent on re-approval) and marks it reviewed.
 * Diffs against what the system proposed (AI output + supplier rule values), so accepting a
 * supplier-rule default is not counted as a correction.
 * Never throws: logging corrections must not block an approval.
 */
export interface CorrectionsBase {
  client_id: string;
  extracted_data: ExtractedData | null;
  validated_data: ExtractedData | null;
}

export async function recordCorrections(
  db: SupabaseClient,
  invoiceId: string,
  approvedData: Partial<ExtractedData>,
  options: {
    /** The invoice as it was BEFORE the approval wrote validated_data (diff base). Loaded when omitted. */
    before?: CorrectionsBase;
    /** Stamp reviewed_at (default true). The approve route sets it in its own atomic update. */
    markReviewed?: boolean;
  } = {}
): Promise<FieldCorrection[]> {
  try {
    let invoice: CorrectionsBase | null = options.before ?? null;
    if (!invoice) {
      const { data, error } = await db
        .from('invoices')
        .select('client_id, extracted_data, validated_data')
        .eq('id', invoiceId)
        .single();
      if (error || !data) throw error ?? new Error('Invoice not found');
      invoice = data as CorrectionsBase;
    }

    const corrections = diffCorrections(systemProposal(invoice.extracted_data, invoice.validated_data), approvedData);
    // Same key as supplier_automation / eligibility (digits only, 8 digits padded to 9).
    const supplierVatId = normalizeVatId(approvedData.supplier_vat_id ?? invoice.extracted_data?.supplier_vat_id);

    await db.from('invoice_corrections').delete().eq('invoice_id', invoiceId);
    if (corrections.length > 0) {
      const { error: insertError } = await db.from('invoice_corrections').insert(
        corrections.map((c) => ({
          invoice_id: invoiceId,
          client_id: invoice.client_id,
          supplier_vat_id: supplierVatId,
          ...c,
        }))
      );
      if (insertError) throw insertError;
    }
    if (options.markReviewed !== false) {
      await db.from('invoices').update({ reviewed_at: new Date().toISOString() }).eq('id', invoiceId);
    }
    return corrections;
  } catch (err) {
    console.error(`[corrections] Failed to record corrections for invoice ${invoiceId}:`, err);
    return [];
  }
}
