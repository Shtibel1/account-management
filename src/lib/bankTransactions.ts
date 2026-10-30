import { randomUUID } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { BankTransaction, Invoice, MatchableInvoice, NormalizedBankRow } from '@/shared/types';
import { bankDedupeKeys } from '@/shared/bankStatement';
import { autoMatch, findCandidates, isMatchableDebit, MAX_CANDIDATES, toMatchableInvoice, usedInvoiceIds } from '@/shared/bankMatch';

// Repository for bank_transactions. Every function takes the db client so routes can pass the
// real Supabase client or the local mock (which has no upsert/range - handled below).

const TABLE = 'bank_transactions';
const PAGE_SIZE = 1000;          // PostgREST's default max rows per request
const KEY_LOOKUP_CHUNK = 100;    // keeps the `in (...)` URL short (~45 chars per key)
const INSERT_CHUNK = 500;

export class BankTableMissingError extends Error {
  constructor() {
    super('טבלת bank_transactions לא קיימת - יש להריץ את המיגרציה 20261030136000_bank_transactions.sql');
  }
}

export class BankActionError extends Error {
  constructor(message: string, public readonly status: number = 400) {
    super(message);
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
  throw new Error(`[bank] ${context}: ${error.message}`);
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

  let inserted = 0;
  for (let i = 0; i < toInsert.length; i += INSERT_CHUNK) {
    const chunk = toInsert.slice(i, i + INSERT_CHUNK);
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

export interface BankOverview {
  transactions: BankTransaction[];
  /** Matchable invoices plus any invoice a line is matched to (for display). */
  invoices: MatchableInvoice[];
  /** Unmatched debit id -> plausible invoice ids, best first. */
  candidates: Record<string, string[]>;
}

export async function loadBankOverview(db: SupabaseClient, clientId: string): Promise<BankOverview> {
  const [transactions, invoices] = await Promise.all([
    loadTransactions(db, clientId),
    loadMatchableInvoices(db, clientId),
  ]);

  // A matched invoice may since have moved out of approved/exported (e.g. reopened for review).
  const known = new Set(invoices.map((i) => i.id));
  const missingIds = [...usedInvoiceIds(transactions)].filter((id) => !known.has(id));
  if (missingIds.length > 0) {
    const { data, error } = await db
      .from('invoices')
      .select('id, file_name, status, validated_data, extracted_data')
      .in('id', missingIds);
    if (error) console.error('[bank] Failed to load matched invoices:', error.message);
    for (const row of (data ?? []) as Pick<Invoice, 'id' | 'file_name' | 'status' | 'validated_data' | 'extracted_data'>[]) {
      invoices.push(toMatchableInvoice(row));
    }
  }

  const used = usedInvoiceIds(transactions);
  const matchable = invoices.filter((i) => i.status === 'approved' || i.status === 'exported');
  const candidates: Record<string, string[]> = {};
  for (const txn of transactions) {
    if (!isMatchableDebit(txn)) continue;
    const list = findCandidates(txn, matchable, used);
    if (list.length > 0) candidates[txn.id] = list.slice(0, MAX_CANDIDATES).map((c) => c.invoiceId);
  }

  return { transactions, invoices, candidates };
}

export type BankAction =
  | { action: 'match'; invoiceId: string }
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
      const { data: invoice } = await db
        .from('invoices')
        .select('id, client_id, status')
        .eq('id', body.invoiceId)
        .single();
      if (!invoice || invoice.client_id !== txn.client_id) {
        throw new BankActionError('החשבונית לא נמצאה אצל הלקוח הזה', 404);
      }
      // Same rule as auto-match (and the picker): only reviewer-approved invoices settle a payment.
      if (invoice.status !== 'approved' && invoice.status !== 'exported') {
        throw new BankActionError('ניתן להתאים רק חשבונית מאושרת', 409);
      }
      const { data: taken, error: takenError } = await db
        .from(TABLE)
        .select('id')
        .eq('matched_invoice_id', body.invoiceId);
      throwDbError(takenError, 'check invoice usage');
      if (((taken ?? []) as { id: string }[]).some((t) => t.id !== txn.id)) {
        throw new BankActionError('החשבונית כבר מותאמת לתנועה אחרת', 409);
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
  throwDbError(updateError, 'update transaction');
  return toTransaction((updated ?? { ...txn, ...update }) as BankTransaction);
}

/** PostgREST PGRST116 = .single() found no row. */
function isNotFound(error: DbError | null): boolean {
  return error?.code === 'PGRST116';
}
