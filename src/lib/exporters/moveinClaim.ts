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

/** Parallel DB round trips per request: a large batch must finish well inside Amplify's ~28s cut. */
export const LEGACY_CLAIM_CONCURRENCY = 8;

/** Runs `fn` over `items` with at most `limit` calls in flight; results keep the input order. */
export async function mapWithLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function claimMoveinInvoices(params: {
  invoices: Invoice[];
  clientId: string;
  correlationId: string;
  store: ExportStore;
  now?: () => number;
  concurrency?: number;
}): Promise<LegacyClaimResult> {
  const now = params.now ?? Date.now;
  const records = await params.store.getRecords(params.invoices.map((i) => i.id), MOVEIN_PLUGIN_ID);
  const byInvoice = new Map(records.map((r) => [r.invoice_id, r]));
  const result: LegacyClaimResult = { claimed: [], skipped: [] };
  let failure: unknown = null;
  type Outcome = { invoice: Invoice; record: InvoiceExportRecord | null; message?: string };
  const outcomes = await mapWithLimit<Invoice, Outcome>(params.invoices, params.concurrency ?? LEGACY_CLAIM_CONCURRENCY, async (invoice) => {
    const previous = byInvoice.get(invoice.id) ?? null;
    const decision = decideLegacyClaim(invoice, previous, now());
    if (decision.action === 'skip') return { invoice, record: null, message: decision.message };
    if (failure) return { invoice, record: null, message: LEGACY_SKIP_MESSAGES.in_progress };
    try {
      const record = await params.store.claim({
        invoiceId: invoice.id,
        clientId: params.clientId,
        pluginId: MOVEIN_PLUGIN_ID,
        correlationId: params.correlationId,
        previous,
      });
      return record ? { invoice, record } : { invoice, record: null, message: LEGACY_SKIP_MESSAGES.in_progress };
    } catch (err) {
      failure = failure ?? err;
      return { invoice, record: null, message: LEGACY_SKIP_MESSAGES.in_progress };
    }
  });
  for (const o of outcomes) {
    if (o.record) result.claimed.push({ invoice: o.invoice, record: o.record });
    else result.skipped.push({ invoice: o.invoice, message: o.message ?? LEGACY_SKIP_MESSAGES.in_progress });
  }
  if (failure) {
    // A DB error mid-way: release what this request already claimed (otherwise those invoices stay
    // "in progress" for PENDING_STALE_MS) and fail the request.
    await releaseClaims(params.store, result.claimed, failure instanceof Error ? failure.message : String(failure));
    throw failure;
  }
  return result;
}

/** Marks this request's claims failed (no file was delivered), so the invoices can be exported again. */
export async function releaseClaims(
  store: ExportStore,
  claimed: { record: InvoiceExportRecord }[],
  message: string
): Promise<void> {
  await mapWithLimit(claimed, LEGACY_CLAIM_CONCURRENCY, (c) =>
    store.complete(c.record.id, { status: 'failed', last_error: message }).catch(() => undefined)
  );
}
