import { isSpecificSupplierName, pickRegistrarMatch, type RegistrarRecord } from '@/shared/supplierNameMatch';
import type { VatIdSources } from '@/shared/types';

/**
 * Total time of one lookup, retry included: it runs inside the review form and the pipeline's
 * finalize step (each HTTP request is cut at ~28s). The same worst case as the single 6 s try before.
 */
const REGISTRAR_BUDGET_MS = 6000;
/** First try of each registrar request; a retry gets what is left of the budget. */
const REGISTRAR_FIRST_TRY_MS = 4000;
/** A retry starts only with at least this much budget left. */
const REGISTRAR_MIN_RETRY_MS = 1000;

/**
 * Outcome of a registrar lookup (QA round 4): 'unavailable' (timeouts / 5xx / network errors, after
 * one retry) is not 'no_match', so the review can show the number was not checked. 'skipped': the
 * name is not one specific business (never looked up).
 */
export type VatLookupStatus = NonNullable<VatIdSources['web_search_status']>;

/** Review warning when the registrar could not be asked (the VAT ID was not cross-checked). */
export const REGISTRAR_UNAVAILABLE_WARNING = 'לא ניתן היה לבדוק את ח.פ. הספק מול רשם החברות (המאגר לא הגיב) — אנא ודא';

export interface VatLookupResult {
  status: VatLookupStatus;
  vatId: string | null;
}

export interface VatLookupOptions {
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  now?: () => number;
  budgetMs?: number;
}

// Official Gov.il Resource IDs for:
// 1. Registered Companies (רשימת חברות)
const COMPANIES_RES = 'f004176c-b85f-4542-8901-7b3176f9a054';
// 2. Partnerships (רשימת שותפויות)
const PARTNERSHIPS_RES = '139aa193-fabb-4f6b-a71b-0bb40fd73eb2';
// 3. Registered Non-Profits/Amutot (עמותות רשומות)
const NON_PROFITS_RES = 'be5b7935-3922-45d4-9638-08871b17ec95';

type RegistrarAnswer = { ok: true; records: Record<string, unknown>[] } | { ok: false; retryable: boolean; reason: string };

/** Timeouts, dropped connections, 429 and 5xx are worth one more try; other statuses are not. */
function retryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

async function queryOnce(fetchImpl: typeof fetch, url: string, timeoutMs: number): Promise<RegistrarAnswer> {
  try {
    const r = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return { ok: false, retryable: retryableStatus(r.status), reason: `status ${r.status}` };
    const body = (await r.json()) as { success?: boolean; result?: { records?: unknown } } | null;
    const records = body?.result?.records;
    // CKAN answers 200 with success: false on its own errors
    if (body?.success === false || !Array.isArray(records)) return { ok: false, retryable: true, reason: 'malformed answer' };
    return { ok: true, records: records as Record<string, unknown>[] };
  } catch (err) {
    // AbortSignal.timeout -> TimeoutError; network drops -> TypeError('fetch failed')
    return { ok: false, retryable: true, reason: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
  }
}

/** One registrar request, retried once on a retryable failure while the budget allows. */
async function queryRegistrar(fetchImpl: typeof fetch, url: string, now: () => number, deadline: number): Promise<RegistrarAnswer> {
  const first = await queryOnce(fetchImpl, url, Math.max(1, Math.min(REGISTRAR_FIRST_TRY_MS, deadline - now())));
  if (first.ok || !first.retryable) return first;
  const left = deadline - now();
  if (left < REGISTRAR_MIN_RETRY_MS) return first;
  console.warn(`[businessLookup] Gov.il request failed (${first.reason}); retrying once.`);
  return queryOnce(fetchImpl, url, left);
}

/**
 * Looks up the official VAT ID (ח.פ. / מספר תאגיד) of a business name in the Israeli Government open
 * data portal (data.gov.il CKAN API): companies, partnerships and non-profits, concurrently.
 */
export async function lookupVatIdByName(supplierName: string, options: VatLookupOptions = {}): Promise<VatLookupResult> {
  // A placeholder ("ספקים שונים") or a generic word ("חברה", "דלק") is not one business: any
  // registrar hit would be an unrelated company whose number gets autofilled as the supplier's
  if (!isSpecificSupplierName(supplierName)) return { status: 'skipped', vatId: null };

  const query = supplierName.trim();
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => Date.now());
  const deadline = now() + (options.budgetMs ?? REGISTRAR_BUDGET_MS);
  const url = (resource: string) =>
    `https://data.gov.il/api/3/action/datastore_search?resource_id=${resource}&q=${encodeURIComponent(query)}&limit=5`;

  try {
    console.log(`[businessLookup] Querying Gov.il API for supplier: "${query}"`);
    const [companies, partnerships, nonProfits] = await Promise.all(
      [COMPANIES_RES, PARTNERSHIPS_RES, NON_PROFITS_RES].map((res) => queryRegistrar(fetchImpl, url(res), now, deadline))
    );
    const answers = [companies, partnerships, nonProfits];
    for (const a of answers) if (!a.ok) console.warn(`[businessLookup] Gov.il request failed: ${a.reason}`);

    // A record must be the queried business as a whole, and an ambiguous query (several different
    // businesses match and none is named exactly like it) gives nothing (see pickRegistrarMatch)
    const recordsOf = (a: RegistrarAnswer) => (a.ok ? a.records : []);
    const records: RegistrarRecord[] = [
      ...recordsOf(companies).map((rec) => ({ name: rec['שם חברה'], number: rec['מספר חברה'] })),
      ...recordsOf(partnerships).map((rec) => ({ name: rec['שם שותפות'], number: rec['מספר שותפות'] })),
      ...recordsOf(nonProfits).map((rec) => ({ name: rec['שם עמותה בעברית'], number: rec['מספר עמותה'] })),
    ];
    const picked = pickRegistrarMatch(query, records);
    if (picked) return { status: 'found', vatId: picked };

    // No record whose name matches. That is "no match" only when every registrar answered: a
    // registrar that didn't may hold the business, so the name was not (fully) checked.
    // (The top full-text hit for a name that matches no record is an unrelated business, and its
    // number would be autofilled as the supplier's, so it is never used.)
    return { status: answers.every((a) => a.ok) ? 'no_match' : 'unavailable', vatId: null };
  } catch (err) {
    console.error('[businessLookup] Unhandled lookup exception:', err);
    return { status: 'unavailable', vatId: null };
  }
}
