import type { SupabaseClient } from '@supabase/supabase-js';
import type { ExtractedData } from '@/shared/types';

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

/** Normalizes a value so formatting-only differences (whitespace, '', 100 vs 100.00) don't count as corrections. */
function normalize(value: unknown): string | number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
  const s = String(value).trim().replace(/\s+/g, ' ');
  if (s === '') return null;
  const asNumber = Number(s.replace(/,/g, ''));
  if (/^-?[\d,]+(\.\d+)?$/.test(s) && Number.isFinite(asNumber)) return Math.round(asNumber * 100) / 100;
  return s;
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
    const ai = normalize(aiData[field]);
    const corrected = normalize(approvedData[field]);
    if (ai !== corrected) corrections.push({ field, ai_value: ai, corrected_value: corrected });
  }
  return corrections;
}

/**
 * Replaces the correction rows for an invoice (idempotent on re-approval) and marks it reviewed.
 * Never throws: logging corrections must not block an approval.
 */
export async function recordCorrections(
  db: SupabaseClient,
  invoiceId: string,
  approvedData: Partial<ExtractedData>
): Promise<FieldCorrection[]> {
  try {
    const { data: invoice, error } = await db
      .from('invoices')
      .select('client_id, extracted_data')
      .eq('id', invoiceId)
      .single();
    if (error || !invoice) throw error ?? new Error('Invoice not found');

    const corrections = diffCorrections(invoice.extracted_data, approvedData);
    const supplierVatId = normalize(approvedData.supplier_vat_id ?? invoice.extracted_data?.supplier_vat_id);

    await db.from('invoice_corrections').delete().eq('invoice_id', invoiceId);
    if (corrections.length > 0) {
      const { error: insertError } = await db.from('invoice_corrections').insert(
        corrections.map((c) => ({
          invoice_id: invoiceId,
          client_id: invoice.client_id,
          supplier_vat_id: supplierVatId === null ? null : String(supplierVatId),
          ...c,
        }))
      );
      if (insertError) throw insertError;
    }
    await db.from('invoices').update({ reviewed_at: new Date().toISOString() }).eq('id', invoiceId);
    return corrections;
  } catch (err) {
    console.error(`[corrections] Failed to record corrections for invoice ${invoiceId}:`, err);
    return [];
  }
}
