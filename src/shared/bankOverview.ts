// Server-side filtering, summary and paging of a client's bank statement lines (GET /api/bank).
// Pure: the repository (src/lib/bankTransactions.ts) loads the rows. The page only ever receives
// one page of lines plus the summary, so the response stays small however many lines a client has
// (the whole list used to be sent at once and broke the ~6 MB response limit at ~10k lines).
import type { BankMatchStatus, BankTransaction, MatchableInvoice } from '@/shared/types';
import { isMatchableDebit } from '@/shared/bankMatch';

export type BankListMode = 'all' | 'missing';
export type BankStatusFilter = 'all' | 'debits' | BankMatchStatus;

export interface BankListQuery {
  /** 'missing' = unmatched debits only (status filter ignored). */
  mode: BankListMode;
  status: BankStatusFilter;
  /** Account label, or null for every account. '' is a valid label (legacy unlabeled lines). */
  account: string | null;
  search: string;
  /** 1-based. */
  page: number;
  pageSize: number;
}

export const DEFAULT_BANK_PAGE_SIZE = 25;
/** Upper bound per request (~575 bytes per line -> well under the response limit). */
export const MAX_BANK_PAGE_SIZE = 1000;

const STATUS_FILTERS: readonly BankStatusFilter[] = ['all', 'debits', 'unmatched', 'auto', 'manual', 'ignored'];

export interface BankSummary {
  total: number;
  debits: number;
  matched: number;
  missing: number;
  missingSum: number;
  ignored: number;
  accountLabels: string[];
}

function positiveInt(raw: string | null, fallback: number): number {
  if (raw === null || !/^\d+$/.test(raw.trim())) return fallback;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

/** Query-string -> BankListQuery. Unknown / invalid values fall back to the defaults. */
export function parseBankListQuery(params: URLSearchParams): BankListQuery {
  const mode: BankListMode = params.get('mode') === 'missing' ? 'missing' : 'all';
  const rawStatus = params.get('status') as BankStatusFilter | null;
  const status: BankStatusFilter = rawStatus && STATUS_FILTERS.includes(rawStatus) ? rawStatus : 'all';
  const account = params.has('account') ? (params.get('account') ?? '') : null;
  return {
    mode,
    status,
    account,
    search: (params.get('q') ?? '').trim().slice(0, 200),
    page: positiveInt(params.get('page'), 1),
    pageSize: Math.min(MAX_BANK_PAGE_SIZE, positiveInt(params.get('pageSize'), DEFAULT_BANK_PAGE_SIZE)),
  };
}

export function summarizeBankTransactions(transactions: readonly BankTransaction[]): BankSummary {
  let debits = 0;
  let matched = 0;
  let missing = 0;
  let missingSum = 0;
  let ignored = 0;
  const labels = new Set<string>();
  for (const t of transactions) {
    if (t.account_label) labels.add(t.account_label);
    if (t.match_status === 'ignored') {
      ignored++;
      continue;
    }
    if (t.amount < 0) {
      debits++;
      if (t.match_status === 'auto' || t.match_status === 'manual') matched++;
    }
    if (isMatchableDebit(t)) {
      missing++;
      missingSum += Math.abs(t.amount);
    }
  }
  return {
    total: transactions.length,
    debits,
    matched,
    missing,
    missingSum: Math.round(missingSum * 100) / 100,
    ignored,
    accountLabels: [...labels].sort(),
  };
}

/**
 * A search query as an amount, the way the table shows it ("-1,234.56", "₪500.00", "123.40"):
 * without ₪, spaces, thousands commas and a leading minus. Null when the query isn't a number.
 * Mirrors v_amount_search in bank_overview() (migration 20261031140000_ux_bank_amount_search.sql).
 */
export function normalizeAmountSearch(query: string): string | null {
  const compact = query.trim().toLowerCase().replace(/[\s₪,]/g, '');
  return /^[-−]?[0-9]+(\.[0-9]*)?$/.test(compact) ? compact.replace(/^[-−]/, '') : null;
}

/** True when the amount (sign ignored) contains the query as shown or as a plain number. */
export function amountMatchesSearch(amount: number, query: string): boolean {
  const abs = Math.abs(amount);
  const plain = String(abs);
  const q = query.trim().toLowerCase();
  if (q && plain.includes(q)) return true;
  const n = normalizeAmountSearch(query);
  return n !== null && (plain.includes(n) || abs.toFixed(2).includes(n));
}

/** Same filters the table used to apply in the browser. */
export function filterBankTransactions(
  transactions: readonly BankTransaction[],
  query: Pick<BankListQuery, 'mode' | 'status' | 'account' | 'search'>,
  invoicesById: ReadonlyMap<string, Pick<MatchableInvoice, 'supplier_name' | 'invoice_number'>>
): BankTransaction[] {
  const q = query.search.trim().toLowerCase();
  return transactions.filter((t) => {
    if (query.mode === 'missing') {
      if (!isMatchableDebit(t)) return false;
    } else if (query.status === 'debits') {
      if (t.amount >= 0) return false;
    } else if (query.status !== 'all' && t.match_status !== query.status) {
      return false;
    }
    if (query.account !== null && t.account_label !== query.account) return false;
    if (q) {
      const inv = t.matched_invoice_id ? invoicesById.get(t.matched_invoice_id) : undefined;
      const haystack = [t.description, t.reference, t.account_label, inv?.supplier_name, inv?.invoice_number];
      if (!haystack.some((v) => v?.toLowerCase().includes(q)) && !amountMatchesSearch(t.amount, q)) return false;
    }
    return true;
  });
}

export interface BankPage<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/** Clamps the page into range (a filter change can shrink the list under the current page). */
export function paginate<T>(rows: readonly T[], page: number, pageSize: number): BankPage<T> {
  const size = Math.max(1, Math.min(MAX_BANK_PAGE_SIZE, Math.floor(pageSize)));
  const totalPages = Math.max(1, Math.ceil(rows.length / size));
  const current = Math.min(Math.max(1, Math.floor(page)), totalPages);
  return {
    rows: rows.slice((current - 1) * size, current * size),
    total: rows.length,
    page: current,
    pageSize: size,
    totalPages,
  };
}
