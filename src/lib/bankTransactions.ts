import { randomUUID } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { BankTransaction, Invoice, MatchableInvoice, NormalizedBankRow } from '@/shared/types';
import { bankDedupeKeys } from '@/shared/bankStatement';
import {
  AMOUNT_TOLERANCE,
  autoMatch,
  type AutoMatch,
  DAYS_AFTER_INVOICE,
  DAYS_BEFORE_INVOICE,
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

/** Rows per staging call: each call is one small, fast statement (one jsonb row), far below the
 * 8 s PostgREST statement timeout and the ~28 s request cut of the Amplify compute. */
const STAGE_CHUNK = 2500;
const STAGE_CONCURRENCY = 4;
const STAGE_RPC = 'stage_bank_import_chunk';
const COMMIT_RPC = 'commit_bank_import';
const STAGING_TABLE = 'bank_import_staging';

type ImportRpcRow = Pick<BankInsertRow, 'txn_date' | 'description' | 'amount' | 'reference' | 'dedupe_key'>;

function toRpcRow(r: BankInsertRow): ImportRpcRow {
  return { txn_date: r.txn_date, description: r.description, amount: r.amount, reference: r.reference, dedupe_key: r.dedupe_key };
}

/** Runs `tasks` with at most `limit` in flight; rejects with the first failure (no new task starts after it). */
async function runLimited(tasks: (() => Promise<void>)[], limit: number): Promise<void> {
  let next = 0;
  let failure: { error: unknown } | null = null;
  const worker = async () => {
    while (!failure && next < tasks.length) {
      const task = tasks[next++];
      try {
        await task();
      } catch (error) {
        if (!failure) failure = { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  if (failure) throw (failure as { error: unknown }).error;
}

type ImportBatch = { clientId: string; accountLabel: string; batchId: string; sourceFile: string | null };

class StageError extends Error {
  constructor(public readonly dbError: DbError) {
    super(dbError.message);
  }
}

/**
 * Large statements (QA round 2 N8): the rows are uploaded in small chunks to bank_import_staging
 * (service role only, invisible to the app), then commit_bank_import() moves the whole batch into
 * bank_transactions in ONE statement - all or nothing - and drops the staging rows. The commit
 * reads the staged rows inside the database (no multi-MB JSON parse in the timed statement) and has
 * its own statement_timeout (function setting, applied by PostgREST). Returns null when the staging
 * functions aren't deployed yet (the caller falls back to the single-call import).
 */
async function importViaStaging(db: SupabaseClient, batch: ImportBatch, rows: BankInsertRow[]): Promise<number | null> {
  const chunks: ImportRpcRow[][] = [];
  for (let i = 0; i < rows.length; i += STAGE_CHUNK) chunks.push(rows.slice(i, i + STAGE_CHUNK).map(toRpcRow));

  const stage = async (seq: number) => {
    const { error } = await db.rpc(STAGE_RPC, {
      p_batch_id: batch.batchId,
      p_client_id: batch.clientId,
      p_account_label: batch.accountLabel,
      p_seq: seq,
      p_rows: chunks[seq],
    });
    if (error) throw new StageError(error as DbError);
  };

  try {
    // The first call also tells whether the staging function is deployed at all.
    try {
      await stage(0);
    } catch (err) {
      if (err instanceof StageError && isMissingFunction(err.dbError)) return null;
      throw err;
    }
    await runLimited(chunks.slice(1).map((_, i) => () => stage(i + 1)), STAGE_CONCURRENCY);

    const { data, error } = await db.rpc(COMMIT_RPC, {
      p_batch_id: batch.batchId,
      p_client_id: batch.clientId,
      p_account_label: batch.accountLabel,
      p_source_file: batch.sourceFile,
      p_chunks: chunks.length,
      p_rows: rows.length,
    });
    if (error) throw new StageError(error as DbError);
    return typeof data === 'number' ? data : Number(data ?? 0);
  } catch (err) {
    // Nothing reached bank_transactions; drop what was staged (stale batches are also purged by
    // stage_bank_import_chunk after a day).
    const { error: cleanupError } = await db.from(STAGING_TABLE).delete().eq('batch_id', batch.batchId);
    if (cleanupError) console.error(`[bank] Failed to drop staged import ${batch.batchId}:`, cleanupError.message);
    if (err instanceof StageError) throwDbError(err.dbError, 'staged import');
    throw err;
  }
}

/**
 * Inserts every new line or none; lines already imported (same client + account + dedupe key) are
 * skipped by the database (ON CONFLICT DO NOTHING), so no per-key lookups are needed up front.
 * Preferred path: import_bank_transactions() for up to one chunk, staging + commit_bank_import()
 * for more (one statement = one transaction either way). Fallback (mock DB / functions not
 * deployed yet): chunked inserts, and on any failure the lines of this batch already written are
 * deleted again.
 */
async function insertAllOrNothing(db: SupabaseClient, batch: ImportBatch, allRows: BankInsertRow[]): Promise<number> {
  if (allRows.length === 0) return 0;

  if (typeof db.rpc === 'function') {
    if (allRows.length > STAGE_CHUNK) {
      const staged = await importViaStaging(db, batch, allRows);
      if (staged !== null) return staged;
      console.warn(`[bank] ${STAGE_RPC}() not deployed, importing in a single call`);
    }
    const { data, error } = await db.rpc(IMPORT_RPC, {
      p_client_id: batch.clientId,
      p_account_label: batch.accountLabel,
      p_batch_id: batch.batchId,
      p_source_file: batch.sourceFile,
      p_rows: allRows.map(toRpcRow),
    });
    if (!isMissingFunction(error)) {
      throwDbError(error, 'import transactions');
      return typeof data === 'number' ? data : Number(data ?? 0);
    }
    console.warn(`[bank] ${IMPORT_RPC}() not deployed, falling back to chunked inserts with rollback`);
  }

  // Fallback: skip keys that already exist (the mock client has no upsert / ON CONFLICT).
  const existing = new Set<string>();
  const keys = allRows.map((r) => r.dedupe_key);
  for (let i = 0; i < keys.length; i += KEY_LOOKUP_CHUNK) {
    const chunk = keys.slice(i, i + KEY_LOOKUP_CHUNK);
    const { data, error } = await db
      .from(TABLE)
      .select('dedupe_key')
      .eq('client_id', batch.clientId)
      .eq('account_label', batch.accountLabel)
      .in('dedupe_key', chunk);
    throwDbError(error, 'check duplicates');
    for (const r of (data ?? []) as { dedupe_key: string }[]) existing.add(r.dedupe_key);
  }
  const rows = allRows.filter((r) => !existing.has(r.dedupe_key));

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

  // Duplicates (lines imported before) are skipped inside insertAllOrNothing.
  const toInsert: BankInsertRow[] = rows.map((r, i) => ({
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
  }));

  const inserted = await insertAllOrNothing(db, { clientId, accountLabel, batchId, sourceFile }, toInsert);
  return { batchId, inserted, duplicates: rows.length - inserted };
}

export interface MatchRunResult {
  matched: number;
  ambiguous: number;
  /**
   * False when the run stopped at its deadline before every confident pair was stored. Running it
   * again continues: matched lines drop out of the next run.
   */
  complete: boolean;
  /**
   * True when some invoices were left out of the run because they have too many candidate lines
   * (more than MAX_LINES_PER_INVOICE, or past the MAX_MATCH_LINES budget of one run). Everything
   * else was matched as usual; running it again does not help for those invoices: their lines have
   * to be matched manually until fewer candidates are open.
   */
  truncated?: boolean;
  /** How many invoices were left out (with truncated). */
  skippedInvoices?: number;
}

export interface AutoMatchOptions {
  /** Epoch ms by which the run must have returned; whatever is left stays for a later run. */
  deadline?: number;
  /** Pairs of this import batch's lines are stored first (the lines the user just imported). */
  preferBatchId?: string;
}

const MATCH_INPUT_RPC = 'bank_auto_match_input';
const APPLY_MATCHES_RPC = 'apply_bank_auto_matches';
/** Candidate lines one run handles; past it whole invoices are left out (see bank_auto_match_input). */
const MAX_MATCH_LINES = 20_000;
/**
 * An invoice with more candidate lines than this (e.g. a recurring charge of the same amount
 * repeated in a bad statement) is left out of auto-matching: it would never be a clear favourite,
 * and its lines would crowd out every other invoice of the client.
 */
const MAX_LINES_PER_INVOICE = 100;
/** Pairs per apply call (one short statement each; the deadline is checked between calls). */
const APPLY_CHUNK = 500;
/** A DB step is started only when at least this much of the deadline is left. */
const MIN_STEP_MS = 1_500;

type MatchLine = Pick<
  BankTransaction,
  'id' | 'txn_date' | 'description' | 'amount' | 'match_status' | 'matched_invoice_id' | 'rejected_invoice_ids' | 'import_batch_id'
> & {
  /** Also a candidate of a left-out invoice: a rival in this run, never matched itself. */
  blocked?: boolean;
};

/** Ran out of time (deadline reached, or the request was aborted at it). */
class DeadlineError extends Error {
  constructor() {
    super('auto-match deadline reached');
  }
}

function remainingMs(deadline: number | undefined): number {
  return deadline == null ? Number.POSITIVE_INFINITY : deadline - Date.now();
}

function assertTime(deadline: number | undefined): void {
  if (remainingMs(deadline) < MIN_STEP_MS) throw new DeadlineError();
}

/** Cuts the request at the deadline when the client supports it (supabase-js; the mock does not). */
function withDeadline<Q>(query: Q, deadline: number | undefined): Q {
  const q = query as Q & { abortSignal?: (signal: AbortSignal) => Q };
  if (deadline == null || typeof q.abortSignal !== 'function') return query;
  return q.abortSignal(AbortSignal.timeout(Math.max(1, remainingMs(deadline))));
}

/** supabase-js reports an aborted fetch as an error object (AbortError), not as a throw. */
function isAbort(error: unknown): boolean {
  const e = error as { name?: string; message?: string; code?: string } | null;
  return !!e && (e.name === 'AbortError' || e.name === 'TimeoutError' || /abort/i.test(e.message ?? ''));
}

interface MatchInput {
  lines: MatchLine[];
  /** Approved/exported invoices of the client not paired with any line yet. */
  invoices: MatchableInvoice[];
  /** Some invoices were left out (too many candidate lines). */
  truncated: boolean;
  skippedInvoices: number;
}

/**
 * Preferred path: bank_auto_match_input() (migrations 20261030192000, 20261031100000) returns, in
 * one call, only the unmatched debits whose amount is within the tolerance of a free invoice's
 * total (every line that can be matched, so also every rival of a match), plus those invoices with
 * just the fields matching needs. Its cost grows with the invoices, not with the client's total
 * line count. Invoices with too many candidate lines are left out (the batch just imported is
 * preferred when the budget runs out); lines that are also theirs come back blocked. Returns null
 * when the function isn't deployed yet.
 */
async function loadMatchInputRpc(
  db: SupabaseClient,
  clientId: string,
  deadline: number | undefined,
  preferBatchId: string | undefined
): Promise<MatchInput | null> {
  if (typeof db.rpc !== 'function') return null;
  assertTime(deadline);
  const { data, error } = await withDeadline(
    db.rpc(MATCH_INPUT_RPC, {
      p_client_id: clientId,
      // A cent of slack: the exact (rounded) comparison runs in autoMatch()
      p_tolerance: AMOUNT_TOLERANCE + 0.01,
      p_max_lines: MAX_MATCH_LINES,
      // The date window of evaluateCandidate(), so only lines autoMatch() can use are returned
      p_days_before: DAYS_BEFORE_INVOICE,
      p_days_after: DAYS_AFTER_INVOICE,
      p_max_per_invoice: MAX_LINES_PER_INVOICE,
      p_prefer_batch_id: preferBatchId ?? null,
    }),
    deadline
  );
  if (error && isAbort(error)) throw new DeadlineError();
  if (isMissingFunction(error)) return null;
  throwDbError(error, 'load auto-match input');
  const body = (data ?? {}) as {
    lines?: MatchLine[] | null;
    invoices?: MatchableInvoice[] | null;
    truncated?: boolean;
    skipped_invoices?: number | null;
  };
  return {
    lines: (body.lines ?? []).map((l) => ({
      ...l,
      amount: Number(l.amount),
      match_status: 'unmatched' as const,
      matched_invoice_id: null,
      rejected_invoice_ids: l.rejected_invoice_ids ?? [],
      blocked: l.blocked === true,
    })),
    invoices: (body.invoices ?? []).map((i) => ({
      ...i,
      total_amount: i.total_amount == null ? null : Number(i.total_amount),
    })),
    truncated: body.truncated === true,
    skippedInvoices: Number(body.skipped_invoices ?? 0),
  };
}

/**
 * Fallback (mock DB / function not deployed): the client's unmatched debits only, with the columns
 * matching needs, page by page with the deadline checked between pages; invoices already paired
 * with a line are dropped from the matchable list.
 */
async function loadMatchInputFallback(db: SupabaseClient, clientId: string, deadline: number | undefined): Promise<MatchInput> {
  const paged = async <T>(makeQuery: () => PagedQuery<T>, context: string): Promise<T[]> => {
    const first = makeQuery();
    if (typeof first.range !== 'function') {
      assertTime(deadline);
      const { data, error } = await first;
      throwDbError(error, context);
      return data ?? [];
    }
    const rows: T[] = [];
    for (let from = 0; ; from += PAGE_SIZE) {
      assertTime(deadline);
      const { data, error } = await withDeadline(makeQuery().range!(from, from + PAGE_SIZE - 1), deadline);
      if (error && isAbort(error)) throw new DeadlineError();
      throwDbError(error, context);
      rows.push(...(data ?? []));
      if (!data || data.length < PAGE_SIZE) return rows;
    }
  };

  const [lines, usedRows, invoices] = await Promise.all([
    paged<MatchLine>(
      () =>
        db
          .from(TABLE)
          .select('id, txn_date, description, amount, match_status, matched_invoice_id, rejected_invoice_ids, import_batch_id')
          .eq('client_id', clientId)
          .eq('match_status', 'unmatched')
          .lt('amount', 0)
          .order('id'),
      'load unmatched lines'
    ),
    paged<{ matched_invoice_id: string | null }>(
      () => db.from(TABLE).select('matched_invoice_id').eq('client_id', clientId).not('matched_invoice_id', 'is', null).order('id'),
      'load matched invoice ids'
    ),
    loadMatchableInvoices(db, clientId),
  ]);
  const used = new Set(usedRows.map((r) => r.matched_invoice_id).filter((id): id is string => !!id));
  return {
    lines: lines.map((l) => ({ ...l, amount: Number(l.amount), rejected_invoice_ids: l.rejected_invoice_ids ?? [] })),
    invoices: invoices.filter((i) => !used.has(i.id)),
    truncated: false,
    skippedInvoices: 0,
  };
}

/**
 * Stores pairs, a chunk per call. Preferred: apply_bank_auto_matches() (one statement per chunk;
 * a pair whose line was handled meanwhile or whose invoice was matched elsewhere is skipped inside
 * it). Fallback: one update per pair. Only lines still unmatched are touched - a reviewer may have
 * acted on them meanwhile. Stops at the deadline; returns how many pairs were stored.
 */
async function applyMatches(
  db: SupabaseClient,
  clientId: string,
  matches: AutoMatch[],
  deadline: number | undefined
): Promise<{ matched: number; complete: boolean }> {
  let matched = 0;
  let useRpc = typeof db.rpc === 'function';
  for (let i = 0; i < matches.length; i += APPLY_CHUNK) {
    if (remainingMs(deadline) < MIN_STEP_MS) return { matched, complete: false };
    const chunk = matches.slice(i, i + APPLY_CHUNK);
    if (useRpc) {
      const { data, error } = await withDeadline(
        db.rpc(APPLY_MATCHES_RPC, {
          p_client_id: clientId,
          p_matches: chunk.map((m) => ({ transaction_id: m.transactionId, invoice_id: m.invoiceId })),
        }),
        deadline
      );
      // An aborted call may still commit in the database; the next run sees those lines as matched.
      if (error && isAbort(error)) return { matched, complete: false };
      if (!isMissingFunction(error)) {
        throwDbError(error, 'apply auto-matches');
        matched += typeof data === 'number' ? data : Number(data ?? 0);
        continue;
      }
      console.warn(`[bank] ${APPLY_MATCHES_RPC}() not deployed, storing auto-matches one by one`);
      useRpc = false;
    }
    for (const m of chunk) {
      if (remainingMs(deadline) < MIN_STEP_MS) return { matched, complete: false };
      const { error } = await withDeadline(
        db
          .from(TABLE)
          .update({ matched_invoice_id: m.invoiceId, match_status: 'auto' })
          .eq('id', m.transactionId)
          .eq('match_status', 'unmatched'),
        deadline
      );
      if (error) {
        if (isAbort(error)) return { matched, complete: false };
        // e.g. the invoice was matched manually to another line in parallel (unique index)
        console.error(`[bank] Auto-match ${m.transactionId} -> ${m.invoiceId} failed:`, error.message);
        continue;
      }
      matched++;
    }
  }
  return { matched, complete: true };
}

/**
 * Runs auto-matching over the client's unmatched debits and stores the confident pairs. Bounded:
 * only lines that can match a free invoice are loaded, the pairs are stored in batches, and with a
 * `deadline` the run returns in time (complete: false) instead of running into the request cut;
 * the rest is matched by the next run (the "הרץ התאמה אוטומטית" button on the bank page).
 */
export async function runAutoMatch(db: SupabaseClient, clientId: string, options: AutoMatchOptions = {}): Promise<MatchRunResult> {
  const { deadline, preferBatchId } = options;
  try {
    const input =
      (await loadMatchInputRpc(db, clientId, deadline, preferBatchId)) ?? (await loadMatchInputFallback(db, clientId, deadline));
    if (input.truncated) {
      // The left-out invoices are not in the input and the lines that are also theirs are blocked
      // (kept as rivals, never matched), so every pair below still saw all of its competitors.
      // Reported as truncated, not just incomplete: another run would leave out the same invoices.
      console.warn(
        `[bank] Auto-match for client ${clientId}: ${input.skippedInvoices} invoice(s) with too many candidate lines left out`
      );
    }
    const result = autoMatch(input.lines, input.invoices);
    let matches = result.matches;
    if (preferBatchId) {
      const inBatch = new Set(input.lines.filter((l) => l.import_batch_id === preferBatchId).map((l) => l.id));
      matches = [...matches.filter((m) => inBatch.has(m.transactionId)), ...matches.filter((m) => !inBatch.has(m.transactionId))];
    }
    const applied = await applyMatches(db, clientId, matches, deadline);
    return {
      matched: applied.matched,
      ambiguous: Object.keys(result.ambiguous).length,
      complete: applied.complete,
      ...(input.truncated ? { truncated: true, skippedInvoices: input.skippedInvoices } : {}),
    };
  } catch (err) {
    if (err instanceof DeadlineError) return { matched: 0, ambiguous: 0, complete: false };
    throw err;
  }
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

const OVERVIEW_RPC = 'bank_overview';
const MISSING_LINES_RPC = 'bank_missing_lines';
/** Lines per export call (~120 bytes each -> well under the response limit). */
export const MISSING_EXPORT_PAGE_SIZE = 5000;

/** Candidates, page invoices and the picker's list for one page of lines. */
async function pageDetails(
  db: SupabaseClient,
  clientId: string,
  rows: BankTransaction[],
  matchable: MatchableInvoice[],
  used: Set<string>
): Promise<Pick<BankOverview, 'invoices' | 'available' | 'candidates'>> {
  const invoicesById = new Map<string, MatchableInvoice>(matchable.map((i) => [i.id, i]));
  const candidates: Record<string, string[]> = {};
  const pageInvoiceIds = new Set<string>();
  for (const txn of rows) {
    if (txn.matched_invoice_id) pageInvoiceIds.add(txn.matched_invoice_id);
    if (!isMatchableDebit(txn)) continue;
    const list = findCandidates(txn, matchable, used);
    if (list.length > 0) candidates[txn.id] = list.slice(0, MAX_CANDIDATES).map((c) => c.invoiceId);
  }
  // Safety net: a matched invoice that is no longer approved/exported (the DB trigger releases
  // those lines, see migration 20261030163000) is still shown, never offered for a new match.
  const missingIds = [...pageInvoiceIds].filter((id) => !invoicesById.has(id));
  if (missingIds.length > 0) {
    for (const inv of await loadMatchedInvoices(db, clientId, missingIds)) invoicesById.set(inv.id, inv);
  }
  // Candidates are always free matchable invoices, so they are in `available`.
  const available = matchable.filter((i) => !used.has(i.id));
  const invoices = [...pageInvoiceIds]
    .map((id) => invoicesById.get(id))
    .filter((i): i is MatchableInvoice => !!i);
  return { invoices, available, candidates };
}

interface OverviewRpcBody extends BankLinesPage {
  summary?: BankSummary;
  /** Approved/exported invoices of the client, fields as toMatchableInvoice() returns them. */
  matchable?: MatchableInvoice[];
  /** The ones of `matchable` already matched to a line. */
  used_invoice_ids?: string[];
}

/**
 * Preferred path: bank_overview() (migration 20261031100000) filters, sorts, pages, counts and
 * summarizes in SQL and returns the slim matchable invoices in the same call, so the cost no
 * longer grows with the client's total line count. Returns null when it isn't deployed yet.
 */
async function loadBankOverviewRpc(
  db: SupabaseClient,
  clientId: string,
  query: BankListQuery,
  linesOnly: boolean
): Promise<BankOverview | null> {
  if (typeof db.rpc !== 'function') return null;
  const { data, error } = await db.rpc(OVERVIEW_RPC, {
    p_client_id: clientId,
    p_mode: query.mode,
    p_status: query.status,
    p_account: query.account,
    p_search: query.search,
    p_page: query.page,
    p_page_size: query.pageSize,
    p_details: !linesOnly,
  });
  if (isMissingFunction(error)) return null;
  throwDbError(error, 'load bank overview');
  const body = (data ?? {}) as Partial<OverviewRpcBody>;
  const lines: BankLinesPage = {
    transactions: (body.transactions ?? []).map(toTransaction),
    total: Number(body.total ?? 0),
    page: Number(body.page ?? 1),
    pageSize: Number(body.pageSize ?? query.pageSize),
    totalPages: Number(body.totalPages ?? 1),
  };
  if (linesOnly) {
    return { ...lines, summary: summarizeBankTransactions([]), invoices: [], available: [], candidates: {} };
  }
  const matchable = (body.matchable ?? []).map((i) => ({
    ...i,
    total_amount: i.total_amount == null ? null : Number(i.total_amount),
  }));
  const used = new Set(body.used_invoice_ids ?? []);
  const summary: BankSummary = { ...summarizeBankTransactions([]), ...(body.summary ?? {}) };
  summary.missingSum = Number(summary.missingSum);
  return { ...lines, summary, ...(await pageDetails(db, clientId, lines.transactions, matchable, used)) };
}

/**
 * Summary over all lines + one filtered page of lines with the invoices / candidates it needs.
 * The response size doesn't grow with the number of lines (only with the page size), and with
 * bank_overview() deployed neither does the work: everything but the page's candidates runs in SQL.
 * `linesOnly` skips invoices, candidates and the summary.
 */
export async function loadBankOverview(
  db: SupabaseClient,
  clientId: string,
  query: BankListQuery,
  options: { linesOnly?: boolean } = {}
): Promise<BankOverview> {
  const viaRpc = await loadBankOverviewRpc(db, clientId, query, options.linesOnly === true);
  if (viaRpc) return viaRpc;

  // Fallback (mock DB / function not deployed): every line loaded and filtered here.
  const [transactions, matchable] = await Promise.all([
    loadTransactions(db, clientId),
    loadMatchableInvoices(db, clientId),
  ]);

  const used = usedInvoiceIds(transactions);
  const invoicesById = new Map<string, MatchableInvoice>(matchable.map((i) => [i.id, i]));
  // Matched invoices that aren't matchable any more: searchable by supplier / number too.
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
  return {
    ...lines,
    summary: summarizeBankTransactions(transactions),
    ...(await pageDetails(db, clientId, page.rows, matchable, used)),
  };
}

/** One line of the missing-invoices export (the sheet's columns). */
export type MissingExportLine = Pick<BankTransaction, 'id' | 'txn_date' | 'account_label' | 'description' | 'reference' | 'amount'>;

export interface MissingExportPage {
  lines: MissingExportLine[];
  /** Pass as `after` for the next page; null = this was the last page. */
  next: string | null;
}

/**
 * One page of the client's unmatched debits for the missing-invoices export, keyset paged by id
 * (bank_missing_lines(), an index range scan per call). Fallback when it isn't deployed: the
 * unmatched debits are loaded and the page cut here.
 */
export async function loadMissingExportPage(
  db: SupabaseClient,
  clientId: string,
  after: string | null,
  limit: number = MISSING_EXPORT_PAGE_SIZE
): Promise<MissingExportPage> {
  const size = Math.max(1, Math.min(MISSING_EXPORT_PAGE_SIZE, Math.floor(limit)));
  let rows: MissingExportLine[] | null = null;
  if (typeof db.rpc === 'function') {
    const { data, error } = await db.rpc(MISSING_LINES_RPC, { p_client_id: clientId, p_after: after, p_limit: size });
    if (!isMissingFunction(error)) {
      throwDbError(error, 'load missing lines');
      rows = (Array.isArray(data) ? data : []) as MissingExportLine[];
    }
  }
  if (rows === null) {
    const all = await selectAll<MissingExportLine>(
      () =>
        db
          .from(TABLE)
          .select('id, txn_date, account_label, description, reference, amount')
          .eq('client_id', clientId)
          .eq('match_status', 'unmatched')
          .lt('amount', 0)
          .order('id'),
      'load missing lines'
    );
    rows = all
      .filter((r) => after === null || r.id > after)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, size);
  }
  const lines = rows.map((r) => ({ ...r, amount: Number(r.amount) }));
  return { lines, next: lines.length === size ? lines[lines.length - 1].id : null };
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
