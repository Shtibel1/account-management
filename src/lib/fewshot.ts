import type { SupabaseClient } from '@supabase/supabase-js';
import {
  FEWSHOT_MAX_EXAMPLES,
  buildFewShotExamples,
  findVatIdCandidates,
  selectFewShotInvoices,
  vatIdQueryVariants,
  type FewShotCorrection,
  type FewShotExample,
  type FewShotSourceInvoice,
} from '@/shared/fewshot';

/** Rows fetched per query; a few spares cover rows the selection drops (empty OCR, duplicates). */
const QUERY_LIMIT = 10;
/** The lookup is an optimization; never let it hold up extraction for long. */
const LOOKUP_TIMEOUT_MS = 5000;
/** Stored OCR text cap (characters); examples only ever use the first/last few KB. */
const MAX_STORED_OCR_CHARS = 50000;

export interface FewShotLookup {
  examples: FewShotExample[];
  supplierVatId: string | null;
}

const EMPTY: FewShotLookup = { examples: [], supplierVatId: null };

/** Set EXTRACTION_FEWSHOT=off to extract without examples (e.g. to compare accuracy). */
export function isFewShotEnabled(): boolean {
  return (process.env.EXTRACTION_FEWSHOT ?? '').toLowerCase() !== 'off';
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

async function fetchReviewedInvoices(
  db: SupabaseClient,
  variants: string[],
  clientId: string | null
): Promise<FewShotSourceInvoice[]> {
  let query = db
    .from('invoices')
    .select('id, client_id, reviewed_at, ocr_text, validated_data')
    .in('validated_data->>supplier_vat_id', variants)
    .not('reviewed_at', 'is', null)
    .not('ocr_text', 'is', null);
  if (clientId) query = query.eq('client_id', clientId);
  const { data, error } = await query.order('reviewed_at', { ascending: false }).limit(QUERY_LIMIT);
  if (error) throw new Error(`invoices query failed: ${error.message}`);
  return (data ?? []) as FewShotSourceInvoice[];
}

async function lookup(
  db: SupabaseClient,
  invoiceId: string,
  tenantId: string,
  ocrText: string
): Promise<FewShotLookup> {
  const candidates = findVatIdCandidates(ocrText);
  if (candidates.length === 0) return EMPTY;
  const variants = vatIdQueryVariants(candidates);

  const rows = await fetchReviewedInvoices(db, variants, tenantId);
  const sameClientUsable = rows.filter((r) => r.id !== invoiceId && r.ocr_text?.trim()).length;
  // Other clients' invoices of the same supplier only fill the gaps (sensitive fields stripped later)
  if (sameClientUsable < FEWSHOT_MAX_EXAMPLES) {
    try {
      rows.push(...(await fetchReviewedInvoices(db, variants, null)));
    } catch (err) {
      console.error('[FewShot] Cross-client example lookup failed, using same-client examples only:', err);
    }
  }

  const selection = selectFewShotInvoices({ candidates, tenantId, currentInvoiceId: invoiceId, rows });
  if (!selection || selection.invoices.length === 0) return EMPTY;

  let corrections: FewShotCorrection[] = [];
  const { data, error } = await db
    .from('invoice_corrections')
    .select('invoice_id, field, ai_value, corrected_value')
    .in('invoice_id', selection.invoices.map((s) => s.invoice.id));
  if (error) {
    // Examples are still useful without the "previously misread" hints
    console.error('[FewShot] Failed to load corrections for examples:', error);
  } else {
    corrections = (data ?? []) as FewShotCorrection[];
  }

  return { examples: buildFewShotExamples(selection, corrections), supplierVatId: selection.supplierVatId };
}

/**
 * Loads per-supplier few-shot examples for an invoice from human-reviewed invoices.
 * Best-effort: any failure (missing columns, mock DB, timeout) returns no examples.
 */
export async function loadFewShotExamples(
  db: SupabaseClient,
  params: { invoiceId: string; tenantId: string; ocrText: string | null }
): Promise<FewShotLookup> {
  if (!isFewShotEnabled() || !params.ocrText?.trim()) return EMPTY;
  try {
    return await withTimeout(lookup(db, params.invoiceId, params.tenantId, params.ocrText), LOOKUP_TIMEOUT_MS);
  } catch (err) {
    console.error(`[FewShot] Example lookup failed for invoice ${params.invoiceId}, extracting without examples:`, err);
    return EMPTY;
  }
}

/**
 * Stores the OCR text (input for future examples) and which examples the extraction used
 * (for comparing accuracy with/without). Separate from the main status update so a database
 * without these columns still saves the extraction. Never throws.
 */
export async function saveExtractionContext(
  db: SupabaseClient,
  invoiceId: string,
  context: { ocrText: string | null; fewShotExampleIds: string[] | null }
): Promise<void> {
  const update: Record<string, unknown> = {};
  if (context.ocrText) update.ocr_text = context.ocrText.slice(0, MAX_STORED_OCR_CHARS);
  if (context.fewShotExampleIds) {
    update.fewshot_example_count = context.fewShotExampleIds.length;
    update.fewshot_example_ids = context.fewShotExampleIds;
  }
  if (Object.keys(update).length === 0) return;
  try {
    const { error } = await db.from('invoices').update(update).eq('id', invoiceId);
    if (error) throw new Error(error.message);
  } catch (err) {
    console.error(`[FewShot] Failed to save OCR text / example usage for invoice ${invoiceId}:`, err);
  }
}
