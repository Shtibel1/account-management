import type { SupabaseClient } from '@supabase/supabase-js';
import type { ExtractedData } from '@/shared/types';
import { findClientOwnVatIds, type FewShotSourceInvoice } from '@/shared/fewshot';
import { summarizeSupplierVatHistory, type SupplierVatHistory, type SupplierVatHistoryRow } from '@/shared/supplierVatHistory';

// History lookups used by validation (src/agents/validation). Best-effort: a failed query means
// "no history" and the caller fails closed where it matters (auto-approve).

/** How many of the client's latest reviewed invoices are scanned for its own (buyer) VAT ID. */
const CLIENT_OWN_ID_SCAN_LIMIT = 40;

interface HistoryRow {
  reviewed_at: string | null;
  // PostgREST JSON-path aliases...
  vat_id?: string | null;
  vat?: number | string | null;
  // ...the mock DB ignores the column list and returns whole rows.
  validated_data?: Partial<ExtractedData> | null;
}

/**
 * The supplier's human-reviewed invoices at this client: how many, and how many carried VAT.
 * Returns null when the query fails (the caller treats that as unknown).
 */
export async function fetchSupplierVatHistory(
  db: SupabaseClient,
  clientId: string,
  supplierVatId: string
): Promise<SupplierVatHistory | null> {
  try {
    const { data, error } = await db
      .from('invoices')
      .select('id, reviewed_at, vat_id:validated_data->>supplier_vat_id, vat:validated_data->>vat_amount')
      .eq('client_id', clientId)
      .in('status', ['approved', 'exported']);
    if (error) throw error;
    const rows: SupplierVatHistoryRow[] = ((data as HistoryRow[] | null) ?? []).map((r) => ({
      reviewed_at: r.reviewed_at,
      supplier_vat_id: r.vat_id ?? r.validated_data?.supplier_vat_id ?? null,
      vat_amount: r.vat ?? r.validated_data?.vat_amount ?? null,
    }));
    return summarizeSupplierVatHistory(rows, supplierVatId);
  } catch (err) {
    console.error(`[validationHistory] Failed to load VAT history of supplier ${supplierVatId}:`, err);
    return null;
  }
}

/**
 * Which of the candidate IDs are the client's own VAT ID (printed as the buyer on invoices from
 * several different suppliers in its reviewed history). Empty on any failure.
 */
export async function fetchClientOwnVatIds(
  db: SupabaseClient,
  clientId: string,
  currentInvoiceId: string,
  candidates: string[]
): Promise<string[]> {
  if (candidates.length === 0) return [];
  try {
    const { data, error } = await db
      .from('invoices')
      .select('id, client_id, reviewed_at, ocr_text, validated_data')
      .eq('client_id', clientId)
      .not('reviewed_at', 'is', null)
      .not('ocr_text', 'is', null)
      .order('reviewed_at', { ascending: false })
      .limit(CLIENT_OWN_ID_SCAN_LIMIT);
    if (error) throw error;
    const rows = ((data ?? []) as FewShotSourceInvoice[]).filter((r) => r.id !== currentInvoiceId);
    return findClientOwnVatIds(candidates, rows);
  } catch (err) {
    console.error(`[validationHistory] Failed to look up the own VAT ID of client ${clientId}:`, err);
    return [];
  }
}
