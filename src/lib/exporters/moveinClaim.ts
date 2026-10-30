import type { Invoice } from '@/shared/types';
import type { InvoiceExportRecord } from '@/integrations/types';
import type { ExportStore } from '@/integrations/store';
import { PENDING_STALE_MS } from '@/integrations/idempotency';

/**
 * Single-winner claim for the legacy Move-in download (POST /api/export), QA N1.
 *
 * The route used to read the approved invoices, build the file and then run an unconditional
 * "status = exported" update, so two parallel requests (double click, two tabs) both returned the
 * file and the invoice was posted to the books twice. Now every invoice is claimed in
 * invoice_exports under plugin "movein" - the SAME row the movein export plugin claims - before the
 * file is built:
 *   - no row        -> INSERT (unique invoice_id + plugin_id: only one request can insert);
 *   - existing row  -> conditional UPDATE on (status, attempts): only one request can win it.
 * A request that loses a claim leaves the invoice out of its file.
 */

/** Plugin id shared with src/integrations/plugins/movein (one claim for both export paths). */
export const MOVEIN_PLUGIN_ID = 'movein';

export type LegacyClaimDecision =
  | { action: 'claim' }
  | { action: 'skip'; reason: 'in_progress' | 'already_exported'; message: string };

export const LEGACY_SKIP_MESSAGES = {
  in_progress: 'ייצוא של החשבונית כבר מתבצע (למשל בלשונית אחרת)',
  already_exported: 'החשבונית כבר יוצאה ל-Move-in. להורדה חוזרת של הקובץ: "ייצוא להנהלת חשבונות" > Move-in עם "ייצוא חוזר / הורדה חוזרת של הקובץ".',
} as const;

/**
 * Pure decision per invoice. The route only loads invoices whose status is 'approved', but that
 * snapshot may be stale (another request may have exported it meanwhile), so a `success` row is
 * re-exported only when the invoice was approved again AFTER that export (reopen -> fix -> approve).
 */
export function decideLegacyClaim(
  invoice: Pick<Invoice, 'reviewed_at'>,
  record: Pick<InvoiceExportRecord, 'status' | 'updated_at' | 'exported_at'> | null,
  now: number,
  staleMs: number = PENDING_STALE_MS
): LegacyClaimDecision {
  if (!record) return { action: 'claim' };
  if (record.status === 'pending') {
    const updated = Date.parse(record.updated_at);
    const age = Number.isNaN(updated) ? Infinity : now - updated;
    // A file has no target system, so a stale pending row (a crashed request) is simply re-claimed.
    return age < staleMs ? { action: 'skip', reason: 'in_progress', message: LEGACY_SKIP_MESSAGES.in_progress } : { action: 'claim' };
  }
  if (record.status === 'success') {
    const exportedAt = Date.parse(record.exported_at ?? record.updated_at);
    const reviewedAt = invoice.reviewed_at ? Date.parse(invoice.reviewed_at) : NaN;
    if (!Number.isNaN(reviewedAt) && !Number.isNaN(exportedAt) && reviewedAt > exportedAt) return { action: 'claim' };
    return { action: 'skip', reason: 'already_exported', message: LEGACY_SKIP_MESSAGES.already_exported };
  }
  return { action: 'claim' }; // failed / skipped
}

export interface LegacyClaimResult {
  claimed: { invoice: Invoice; record: InvoiceExportRecord }[];
  skipped: { invoice: Invoice; message: string }[];
}

export async function claimMoveinInvoices(params: {
  invoices: Invoice[];
  clientId: string;
  correlationId: string;
  store: ExportStore;
  now?: () => number;
}): Promise<LegacyClaimResult> {
  const now = params.now ?? Date.now;
  const records = await params.store.getRecords(params.invoices.map((i) => i.id), MOVEIN_PLUGIN_ID);
  const byInvoice = new Map(records.map((r) => [r.invoice_id, r]));
  const result: LegacyClaimResult = { claimed: [], skipped: [] };
  for (const invoice of params.invoices) {
    const previous = byInvoice.get(invoice.id) ?? null;
    const decision = decideLegacyClaim(invoice, previous, now());
    if (decision.action === 'skip') {
      result.skipped.push({ invoice, message: decision.message });
      continue;
    }
    const record = await params.store.claim({
      invoiceId: invoice.id,
      clientId: params.clientId,
      pluginId: MOVEIN_PLUGIN_ID,
      correlationId: params.correlationId,
      previous,
    });
    if (!record) result.skipped.push({ invoice, message: LEGACY_SKIP_MESSAGES.in_progress });
    else result.claimed.push({ invoice, record });
  }
  return result;
}
