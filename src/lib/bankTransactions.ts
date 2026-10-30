import { randomUUID } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { BankTransaction, Invoice, MatchableInvoice, NormalizedBankRow } from '@/shared/types';
import { bankDedupeKeys } from '@/shared/bankStatement';
import {
  AMOUNT_TOLERANCE,
  autoMatch,
  findCandidates,
  isMatchableDebit,
  MAX_CANDIDATES,
  toMatchableInvoice,
  usedInvoiceIds,
} from '@/shared/bankMatch';
import {
  filterBankTransactions,
  paginate,
  summarizeBankTransactions,
  type BankListQuery,
  type BankSummary,
} from '@/shared/bankOverview';
import { formatIsoDateHe } from '@/lib/exporters/missingInvoices';

// Repository for bank_transactions. Every function takes the db client so routes can pass the
// real Supabase client or the local mock (which has no upsert/range - handled below).

const TABLE = 'bank_transactions';
const PAGE_SIZE = 1000;          // PostgREST's default max rows per request
const KEY_LOOKUP_CHUNK = 100;    // keeps the `in (...)` URL short (~45 chars per key)
const INSERT_CHUNK = 500;
const IMPORT_RPC = 'import_bank_transactions';

export class BankTableMissingError extends Error {
  constructor() {
    super('טבלת bank_transactions לא קיימת - יש להריץ את המיגרציה 20261030136000_bank_transactions.sql');
  }
}

export class BankActionError extends Error {
  constructor(
    message: string,
    public readonly status: number = 400,
    /** Machine-readable reason for the UI, e.g. 'amount_mismatch' (confirm and retry with force). */
    public readonly code?: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
  }
}

/** A database / storage failure. The message is Hebrew and safe to show; the cause is only logged. */
export class BankDbError extends Error {
  constructor(public readonly context: string, public readonly cause: DbError) {
    super('שגיאה בגישה לנתוני הבנק - נסו שוב מאוחר יותר');
    this.name = 'BankDbError';
  }
}

interface DbError {
  code?: string;
  message: string;
}

/** Postgres 42P01 / PostgREST PGRST205: the migration hasn't been applied yet. */
function isMissingTable(error: DbError | null): boolean {
  if (!error) return false;
  return (
    error.code === '42P01' ||
    error.code === 'PGRST205' ||
    (/bank_transactions/.test(error.message) && /does not exist|could not find/i.test(error.message))
  );
}

function throwDbError(error: DbError | null, context: string): void {
  if (!error) return;
  if (isMissingTable(error)) throw new BankTableMissingError();
  console.error(`[bank] ${context}:`, error.code ?? '', error.message);
  throw new BankDbError(context, error);
}

type PageResult<T> = PromiseLike<{ data: T[] | null; error: DbError | null }>;
interface PagedQuery<T> extends PageResult<T> {
  range?: (from: number, to: number) => PageResult<T>;
}

/** Reads every row of a query, paging past the 1000-row cap when the client supports .range(). */
async function selectAll<T>(makeQuery: () => PagedQuery<T>, context: string): Promise<T[]> {
  const first = makeQuery();
  if (typeof first.range !== 'function') {
    const { data, error } = await first;
    throwDbError(error, context);
    return data ?? [];
  }
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const query = makeQuery();
    const { data, error } = await query.range!(from, from + PAGE_SIZE - 1);
    throwDbError(error, context);
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE_SIZE) return rows;
  }
}

function toTransaction(row: BankTransaction): BankTransaction {
  return {
    ...row,
    amount: Number(row.amount),     // numeric comes back as a string from PostgREST
    rejected_invoice_ids: row.rejected_invoice_ids ?? [],
  };
}

export async function loadTransactions(db: SupabaseClient, clientId: string): Promise<BankTransaction[]> {
  // Ordered by id so pages are stable; display order is applied below (the mock keeps only one .order()).
  const rows = await selectAll<BankTransaction>(
    () => db.from(TABLE).select('*').eq('client_id', clientId).order('id'),
    'load transactions'
  );
  return rows
    .map(toTransaction)
    .sort((a, b) => b.txn_date.localeCompare(a.txn_date) || a.account_label.localeCompare(b.account_label) || a.dedupe_key.localeCompare(b.dedupe_key));
}

/** Approved/exported invoices of the client - the ones a payment can be matched against. */
export async function loadMatchableInvoices(db: SupabaseClient, clientId: string): Promise<MatchableInvoice[]> {
  type Row = Pick<Invoice, 'id' | 'file_name' | 'status' | 'validated_data' | 'extracted_data'>;
  const rows = await selectAll<Row>(
    () =>
      db
        .from('invoices')
        .select('id, file_name, status, validated_data, extracted_data')
        .eq('client_id', clientId)
        .in('status', ['approved', 'exported'])
        .order('id'),
    'load invoices'
  );
  return rows.map(toMatchableInvoice);
}

type BankInsertRow = Omit<BankTransaction, 'id' | 'created_at'>;

/** PostgREST PGRST202 / Postgres 42883: the import function isn't deployed yet. */
function isMissingFunction(error: DbError | null): boolean {
  return !!error && (error.code === 'PGRST202' || error.code === '42883');
}

/**
 * Inserts every new line or none. Preferred path: the import_bank_transactions() SQL function (one
 * statement = one transaction). Fallback (mock DB / function not deployed yet): chunked inserts,
 * and on any failure the lines of this batch already written are deleted again.
 */
async function insertAllOrNothing(
  db: SupabaseClient,
  batch: { clientId: string; accountLabel: string; batchId: string; sourceFile: string | null },
  rows: BankInsertRow[]
): Promise<number> {
  if (rows.length === 0) return 0;

  if (typeof db.rpc === 'function') {
    const { data, error } = await db.rpc(IMPORT_RPC, {
      p_client_id: batch.clientId,
      p_account_label: batch.accountLabel,
      p_batch_id: batch.batchId,
      p_source_file: batch.sourceFile,
      p_rows: rows.map((r) => ({
        txn_date: r.txn_date,
        description: r.description,
        amount: r.amount,
        reference: r.reference,
        dedupe_key: r.dedupe_key,
      })),
    });
    if (!isMissingFunction(error)) {
      throwDbError(error, 'import transactions');
      return typeof data === 'number' ? data : Number(data ?? 0);
    }
    console.warn(`[bank] ${IMPORT_RPC}() not deployed, falling back to chunked inserts with rollback`);
  }

  let inserted = 0;
  try {
    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
      const chunk = rows.slice(i, i + INSERT_CHUNK);
      const builder = db.from(TABLE);
      // The unique index is the real guard (two imports racing); the mock client has no upsert.
      const { data, error } =
        typeof builder.upsert === 'function'
          ? await builder
              .upsert(chunk, { onConflict: 'client_id,account_label,dedupe_key', ignoreDuplicates: true })
              .select('id')
          : await builder.insert(chunk);
      throwDbError(error, 'insert transactions');
      inserted += Array.isArray(data) ? data.length : chunk.length;
    }
  } catch (err) {
    if (inserted > 0) {
      const { error: undoError } = await db.from(TABLE).delete().eq('import_batch_id', batch.batchId);
      if (undoError) console.error(`[bank] Failed to roll back import batch ${batch.batchId}:`, undoError.message);
    }
    throw err;
  }
  return inserted;
}

export interface ImportResult {
  batchId: string;
  inserted: number;
  duplicates: number;
}

/** Stores normalized statement rows; lines already imported (same dedupe key) are skipped. */
export async function importBankRows(
  db: SupabaseClient,
  params: { clientId: string; accountLabel: string; sourceFile: string | null; rows: NormalizedBankRow[] }
): Promise<ImportResult> {
  const { clientId, sourceFile, rows } = params;
  const accountLabel = params.accountLabel.trim();
  const batchId = randomUUID();
  const keys = bankDedupeKeys(rows);

  const existing = new Set<string>();
  for (let i = 0; i < keys.length; i += KEY_LOOKUP_CHUNK) {
    const chunk = keys.slice(i, i + KEY_LOOKUP_CHUNK);
    const { data, error } = await db
      .from(TABLE)
      .select('dedupe_key')
      .eq('client_id', clientId)
      .eq('account_label', accountLabel)
      .in('dedupe_key', chunk);
    throwDbError(error, 'check duplicates');
    for (const r of (data ?? []) as { dedupe_key: string }[]) existing.add(r.dedupe_key);
  }

  const toInsert = rows
    .map((r, i) => ({
      client_id: clientId,
      account_label: accountLabel,
      txn_date: r.txn_date,
      description: r.description,
      amount: r.amount,
      reference: r.reference,
      matched_invoice_id: null,
      match_status: 'unmatched' as const,
      rejected_invoice_ids: [] as string[],
      dedupe_key: keys[i],
      import_batch_id: batchId,
      source_file: sourceFile,
    }))
    .filter((r) => !existing.has(r.dedupe_key));

  const inserted = await insertAllOrNothing(db, { clientId, accountLabel, batchId, sourceFile }, toInsert);
  return { batchId, inserted, duplicates: rows.length - inserted };
}

export interface MatchRunResult {
  matched: number;
  ambiguous: number;
}

/** Runs auto-matching over the client's unmatched debits and stores the confident pairs. */
export async function runAutoMatch(db: SupabaseClient, clientId: string): Promise<MatchRunResult> {
  const [transactions, invoices] = await Promise.all([
    loadTransactions(db, clientId),
    loadMatchableInvoices(db, clientId),
  ]);
  const result = autoMatch(transactions, invoices);

  let matched = 0;
  for (const m of result.matches) {
    // Only touch lines still unmatched - a reviewer may have acted on them meanwhile.
    const { error } = await db
      .from(TABLE)
      .update({ matched_invoice_id: m.invoiceId, match_status: 'auto' })
      .eq('id', m.transactionId)
      .eq('match_status', 'unmatched');
    if (error) {
      // e.g. the invoice was matched manually to another line in parallel (unique index)
      console.error(`[bank] Auto-match ${m.transactionId} -> ${m.invoiceId} failed:`, error.message);
      continue;
    }
    matched++;
  }
  return { matched, ambiguous: Object.keys(result.ambiguous).length };
}

export interface BankLinesPage {
  /** One page of lines (after filters), display order. */
  transactions: BankTransaction[];
  /** Lines matching the filters, across all pages. */
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface BankOverview extends BankLinesPage {
  /** Counts over ALL the client's lines (not just this page). */
  summary: BankSummary;
  /** Invoices the lines of this page are matched to or could be matched to (for display). */
  invoices: MatchableInvoice[];
  /** Approved/exported invoices not matched to any line - the manual picker's list. */
  available: MatchableInvoice[];
  /** Unmatched debit id (of this page) -> plausible invoice ids, best first. */
  candidates: Record<string, string[]>;
}

type InvoiceDisplayRow = Pick<Invoice, 'id' | 'file_name' | 'status' | 'validated_data' | 'extracted_data'>;

/** Invoices the client's lines are matched to but that aren't matchable any more (display only). */
async function loadMatchedInvoices(db: SupabaseClient, clientId: string, ids: string[]): Promise<MatchableInvoice[]> {
  const result: MatchableInvoice[] = [];
  for (let i = 0; i < ids.length; i += KEY_LOOKUP_CHUNK) {
    const { data, error } = await db
      .from('invoices')
      .select('id, file_name, status, validated_data, extracted_data')
      .eq('client_id', clientId) // never show another client's invoice on this client's page
      .in('id', ids.slice(i, i + KEY_LOOKUP_CHUNK));
    if (error) {
      console.error('[bank] Failed to load matched invoices:', error.message);
      continue;
    }
    for (const row of (data ?? []) as InvoiceDisplayRow[]) result.push(toMatchableInvoice(row));
  }
  return result;
}

/**
 * Summary over all lines + one filtered page of lines with the invoices / candidates it needs.
 * The response size no longer grows with the number of lines (only with the page size).
 * `linesOnly` skips invoices, candidates and the summary (paged export of the missing list).
 */
export async function loadBankOverview(
  db: SupabaseClient,
  clientId: string,
  query: BankListQuery,
  options: { linesOnly?: boolean } = {}
): Promise<BankOverview> {
  const [transactions, matchable] = await Promise.all([
    loadTransactions(db, clientId),
    loadMatchableInvoices(db, clientId),
  ]);

  const used = usedInvoiceIds(transactions);
  const invoicesById = new Map<string, MatchableInvoice>(matchable.map((i) => [i.id, i]));
  // Safety net: a matched invoice that is no longer approved/exported (the DB trigger releases
  // those lines, see migration 20261030163000) is still shown, never offered for a new match.
  const missingIds = [...used].filter((id) => !invoicesById.has(id));
  if (missingIds.length > 0) {
    for (const inv of await loadMatchedInvoices(db, clientId, missingIds)) invoicesById.set(inv.id, inv);
  }

  const filtered = filterBankTransactions(transactions, query, invoicesById);
  const page = paginate(filtered, query.page, query.pageSize);
  const lines: BankLinesPage = {
    transactions: page.rows,
    total: page.total,
    page: page.page,
    pageSize: page.pageSize,
    totalPages: page.totalPages,
  };
  if (options.linesOnly) {
    return { ...lines, summary: summarizeBankTransactions([]), invoices: [], available: [], candidates: {} };
  }

  const candidates: Record<string, string[]> = {};
  const pageInvoiceIds = new Set<string>();
  for (const txn of page.rows) {
    if (txn.matched_invoice_id) pageInvoiceIds.add(txn.matched_invoice_id);
    if (!isMatchableDebit(txn)) continue;
    const list = findCandidates(txn, matchable, used);
    if (list.length > 0) candidates[txn.id] = list.slice(0, MAX_CANDIDATES).map((c) => c.invoiceId);
  }

  // Candidates are always free matchable invoices, so they are in `available`.
  const available = matchable.filter((i) => !used.has(i.id));
  const invoices = [...pageInvoiceIds]
    .map((id) => invoicesById.get(id))
    .filter((i): i is MatchableInvoice => !!i);

  return { ...lines, summary: summarizeBankTransactions(transactions), invoices, available, candidates };
}

/**
 * Releases the lines matched to an invoice (it moved to another client or left approved/exported).
 * The DB trigger invoices_release_bank_matches does the same for every write path; this keeps the
 * API path explicit and covers the mock DB. Never throws: returns how many lines were released.
 */
export async function releaseBankMatchesForInvoice(db: SupabaseClient, invoiceId: string): Promise<number> {
  try {
    const { data, error } = await db
      .from(TABLE)
      .update({ matched_invoice_id: null, match_status: 'unmatched' })
      .eq('matched_invoice_id', invoiceId)
      .select('id');
    if (error) {
      if (!isMissingTable(error)) console.error(`[bank] Failed to release bank matches of invoice ${invoiceId}:`, error.message);
      return 0;
    }
    return Array.isArray(data) ? data.length : 0;
  } catch (err) {
    console.error(`[bank] Failed to release bank matches of invoice ${invoiceId}:`, err);
    return 0;
  }
}

/** True when an invoice update means its bank lines must be released. */
export function invoiceUpdateReleasesBankMatch(
  before: { client_id?: unknown; status?: unknown },
  after: { client_id?: unknown; status?: unknown }
): boolean {
  if (before.client_id !== after.client_id) return true;
  return before.status !== after.status && after.status !== 'approved' && after.status !== 'exported';
}

export type BankAction =
  | { action: 'match'; invoiceId: string; force?: boolean }
  | { action: 'unmatch' }
  | { action: 'ignore' }
  | { action: 'restore' };

/** Manual match / unmatch / ignore / restore of one statement line. */
export async function applyBankAction(db: SupabaseClient, transactionId: string, body: BankAction): Promise<BankTransaction> {
  const { data: current, error } = await db.from(TABLE).select('*').eq('id', transactionId).single();
  throwDbError(isNotFound(error) ? null : error, 'load transaction');
  if (!current) throw new BankActionError('התנועה לא נמצאה', 404);
  const txn = toTransaction(current as BankTransaction);

  let update: Partial<BankTransaction>;
  switch (body.action) {
    case 'match': {
      // Only debits need a supplier invoice (same rule as auto-match and the "התאם" button).
      if (!(txn.amount < 0)) {
        throw new BankActionError('ניתן להתאים חשבונית רק לחיוב (תנועה בסכום שלילי)', 409, 'not_a_debit');
      }
      if (txn.match_status === 'ignored') {
        throw new BankActionError('התנועה הוחרגה - יש לשחזר אותה לפני התאמה', 409, 'ignored');
      }
      const { data: invoice } = await db
        .from('invoices')
        .select('id, client_id, status, file_name, validated_data, extracted_data')
        .eq('id', body.invoiceId)
        .single();
      if (!invoice || invoice.client_id !== txn.client_id) {
        throw new BankActionError('החשבונית לא נמצאה אצל הלקוח הזה', 404);
      }
      // Same rule as auto-match (and the picker): only reviewer-approved invoices settle a payment.
      if (invoice.status !== 'approved' && invoice.status !== 'exported') {
        throw new BankActionError('ניתן להתאים רק חשבונית מאושרת', 409);
      }
      // A total outside the auto-match tolerance is allowed only as an explicit, confirmed override.
      const total = toMatchableInvoice(invoice as InvoiceDisplayRow).total_amount;
      const charge = Math.abs(txn.amount);
      const diff = total == null ? null : Math.round(Math.abs(charge - total) * 100) / 100;
      if ((diff == null || diff > AMOUNT_TOLERANCE) && body.force !== true) {
        throw new BankActionError(
          total == null
            ? 'לחשבונית אין סכום כולל - יש לאשר את ההתאמה'
            : `סכום החשבונית (${total.toFixed(2)}) שונה מסכום החיוב (${charge.toFixed(2)}) - יש לאשר התאמה בסכום שונה`,
          409,
          'amount_mismatch',
          { invoiceTotal: total, amount: charge, difference: diff }
        );
      }
      const { data: taken, error: takenError } = await db
        .from(TABLE)
        .select('id, client_id, txn_date, description, account_label')
        .eq('matched_invoice_id', body.invoiceId);
      throwDbError(takenError, 'check invoice usage');
      type Holder = Pick<BankTransaction, 'id' | 'client_id' | 'txn_date' | 'description' | 'account_label'>;
      const holder = ((taken ?? []) as Holder[]).find((t) => t.id !== txn.id);
      if (holder) {
        const where =
          holder.client_id === txn.client_id
            ? ` (${formatIsoDateHe(holder.txn_date)} · ${holder.description}${holder.account_label ? ` · ${holder.account_label}` : ''})`
            : ' של לקוח אחר';
        throw new BankActionError(`החשבונית כבר מותאמת לתנועה אחרת${where} - יש לבטל שם את ההתאמה`, 409, 'invoice_taken');
      }
      update = { matched_invoice_id: body.invoiceId, match_status: 'manual' };
      break;
    }
    case 'unmatch': {
      // Remember the rejection so the next auto-match run doesn't propose the same invoice again.
      const rejected = new Set(txn.rejected_invoice_ids ?? []);
      if (txn.matched_invoice_id) rejected.add(txn.matched_invoice_id);
      update = { matched_invoice_id: null, match_status: 'unmatched', rejected_invoice_ids: [...rejected] };
      break;
    }
    case 'ignore':
      update = { matched_invoice_id: null, match_status: 'ignored' };
      break;
    case 'restore':
      update = { match_status: 'unmatched', matched_invoice_id: null };
      break;
  }

  const { data: updated, error: updateError } = await db
    .from(TABLE)
    .update(update)
    .eq('id', transactionId)
    .select('*')
    .single();
  if (updateError?.code === '23505') throw new BankActionError('החשבונית כבר מותאמת לתנועה אחרת', 409);
  if (isInvalidMatchError(updateError)) {
    // DB trigger bank_transactions_check_match: the invoice changed (client / status) meanwhile.
    throw new BankActionError('החשבונית כבר אינה מאושרת או שהועברה ללקוח אחר - רעננו את המסך', 409, 'invoice_not_matchable');
  }
  throwDbError(updateError, 'update transaction');
  return toTransaction((updated ?? { ...txn, ...update }) as BankTransaction);
}

/** Raised by the bank_transactions_check_match trigger (migration 20261030163000). */
export function isInvalidMatchError(error: DbError | null | undefined): boolean {
  return !!error && error.code === 'P0001' && /bank_match_invalid/.test(error.message ?? '');
}

/** PostgREST PGRST116 = .single() found no row. */
function isNotFound(error: DbError | null): boolean {
  return error?.code === 'PGRST116';
}
