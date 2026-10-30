import type { SupabaseClient } from '@supabase/supabase-js';
import type { DuplicateMatch, ExtractedData, ValidationResult } from '@/shared/types';
import {
  dismissDuplicateInFlags,
  findDuplicateMatches,
  fuzzyDateWindow,
  normalizeInvoiceNumber,
  type DuplicateCandidateRow,
} from '@/shared/duplicates';

// DB side of duplicate detection: candidate lookup, dismissed pairs, flag updates.
// Everything degrades gracefully when the duplicate migration isn't applied (or on the mock DB).

const DISMISSALS_TABLE = 'duplicate_dismissals';
const CANDIDATES_RPC = 'find_duplicate_candidates';

export class DuplicateDismissalError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'DuplicateDismissalError';
  }
}

interface InvoiceRow extends DuplicateCandidateRow {
  client_id: string;
}

async function getInvoice(db: SupabaseClient, invoiceId: string): Promise<InvoiceRow | null> {
  const { data, error } = await db.from('invoices').select('*').eq('id', invoiceId).single();
  if (error || !data) return null;
  return data as InvoiceRow;
}

/**
 * Invoices of the client that could be duplicates. Uses the find_duplicate_candidates RPC
 * (indexed pre-filter) and falls back to all the client's invoices when it isn't available.
 * The exact rules are applied afterwards in findDuplicateMatches either way.
 */
async function loadCandidates(
  db: SupabaseClient,
  clientId: string,
  invoiceId: string,
  fileHash: string | null,
  data: Partial<ExtractedData>
): Promise<DuplicateCandidateRow[]> {
  if (typeof db.rpc === 'function') {
    const window = fuzzyDateWindow(data.invoice_date);
    const { data: rows, error } = await db.rpc(CANDIDATES_RPC, {
      p_client_id: clientId,
      p_invoice_id: invoiceId,
      p_file_hash: fileHash,
      p_invoice_number: normalizeInvoiceNumber(data.invoice_number),
      p_date_from: window?.from ?? null,
      p_date_to: window?.to ?? null,
    });
    if (!error && Array.isArray(rows)) return rows as DuplicateCandidateRow[];
    console.warn(`[duplicates] ${CANDIDATES_RPC} unavailable, scanning the client's invoices instead:`, error?.message);
  }

  const { data: rows, error } = await db.from('invoices').select('*').eq('client_id', clientId);
  if (error) throw new Error(`Failed to load duplicate candidates: ${error.message}`);
  return (rows ?? []) as DuplicateCandidateRow[];
}

/** Ids of invoices the reviewer already marked as "not a duplicate" of this one (either direction). */
export async function loadDismissedOtherIds(db: SupabaseClient, invoiceId: string): Promise<Set<string>> {
  const ids = new Set<string>();
  // Two simple filters instead of .or() so the mock DB supports it too
  const [asInvoice, asOther] = await Promise.all([
    db.from(DISMISSALS_TABLE).select('other_invoice_id').eq('invoice_id', invoiceId),
    db.from(DISMISSALS_TABLE).select('invoice_id').eq('other_invoice_id', invoiceId),
  ]);
  if (asInvoice.error || asOther.error) {
    console.error('[duplicates] Failed to load dismissed duplicate pairs:', asInvoice.error ?? asOther.error);
    return ids;
  }
  for (const row of (asInvoice.data ?? []) as { other_invoice_id: string }[]) ids.add(row.other_invoice_id);
  for (const row of (asOther.data ?? []) as { invoice_id: string }[]) ids.add(row.invoice_id);
  return ids;
}

/** Suspected duplicates of an invoice, given its current (corrected) data. Throws on DB failure. */
export async function findDuplicatesForInvoice(
  db: SupabaseClient,
  clientId: string,
  invoiceId: string,
  data: Partial<ExtractedData>
): Promise<DuplicateMatch[]> {
  const self = await getInvoice(db, invoiceId);
  const fileHash = self?.file_hash ?? null;
  const [candidates, dismissed] = await Promise.all([
    loadCandidates(db, clientId, invoiceId, fileHash, data),
    loadDismissedOtherIds(db, invoiceId),
  ]);
  return findDuplicateMatches({ id: invoiceId, file_hash: fileHash, data }, candidates, dismissed);
}

async function clearDismissedFlag(db: SupabaseClient, invoice: InvoiceRow, otherInvoiceId: string): Promise<ValidationResult | null> {
  const validated = invoice.validated_data;
  const flags = validated?.validation_flags;
  if (!validated || !flags) return null;
  // Nothing to clear: don't rewrite (possibly approved / exported) data, and don't drop a legacy
  // flag (no duplicate_matches) that may point at a different invoice
  if (!(flags.duplicate_matches ?? []).some((m) => m.invoice_id === otherInvoiceId)) return flags;
  const updatedFlags = dismissDuplicateInFlags(flags, otherInvoiceId, validated.invoice_number ?? null);
  const { error } = await db
    .from('invoices')
    .update({ validated_data: { ...validated, validation_flags: updatedFlags } })
    .eq('id', invoice.id);
  if (error) throw new Error(`Failed to clear duplicate flag on invoice ${invoice.id}: ${error.message}`);
  return updatedFlags;
}

/**
 * Records that `invoiceId` is not a duplicate of `otherInvoiceId` (order-independent, idempotent)
 * and removes the flag from both invoices' validated_data. Returns this invoice's updated flags.
 */
export async function dismissDuplicate(
  db: SupabaseClient,
  invoiceId: string,
  otherInvoiceId: string
): Promise<ValidationResult | null> {
  if (invoiceId === otherInvoiceId) {
    throw new DuplicateDismissalError('An invoice cannot be dismissed against itself', 400);
  }
  const [invoice, other] = await Promise.all([getInvoice(db, invoiceId), getInvoice(db, otherInvoiceId)]);
  if (!invoice || !other) throw new DuplicateDismissalError('Invoice not found', 404);
  if (invoice.client_id !== other.client_id) {
    throw new DuplicateDismissalError('Invoices belong to different clients', 400);
  }

  const dismissed = await loadDismissedOtherIds(db, invoiceId);
  if (!dismissed.has(otherInvoiceId)) {
    const { error } = await db.from(DISMISSALS_TABLE).insert({
      client_id: invoice.client_id,
      invoice_id: invoiceId,
      other_invoice_id: otherInvoiceId,
      dismissed_at: new Date().toISOString(),
    });
    // 23505: the same pair was dismissed concurrently from the other invoice - already done
    if (error && error.code !== '23505') {
      throw new Error(`Failed to record duplicate dismissal: ${error.message}`);
    }
  }

  const updatedFlags = await clearDismissedFlag(db, invoice, otherInvoiceId);
  try {
    await clearDismissedFlag(db, other, invoiceId);
  } catch (err) {
    // The pair is dismissed; the other invoice just keeps a stale flag until it is re-validated
    console.error('[duplicates] Failed to clear the reciprocal duplicate flag:', err);
  }
  return updatedFlags;
}
