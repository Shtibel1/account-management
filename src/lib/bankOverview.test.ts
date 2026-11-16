import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import { loadBankOverview, loadMissingExportPage } from '@/lib/bankTransactions';
import type { BankListQuery } from '@/shared/bankOverview';
import { missingInvoicesSheetRows } from '@/lib/exporters/missingInvoices';

// GET /api/bank and the missing-invoices export (QA round 4): with the SQL functions deployed the
// work runs in the database (one RPC per call), without them the old JS path still works.

interface Call {
  fn: string;
  args: Record<string, unknown>;
}

function txnRow(id: string, amount: number | string, status = 'unmatched', matched: string | null = null) {
  return {
    id,
    client_id: 'client-1',
    account_label: 'לאומי',
    txn_date: '2026-09-05',
    description: `תנועה ${id}`,
    amount,
    reference: null,
    matched_invoice_id: matched,
    match_status: status,
    rejected_invoice_ids: null,
    dedupe_key: id,
    import_batch_id: 'batch-1',
    source_file: null,
  };
}

type Rpc = (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;

const NOT_DEPLOYED: Rpc = () => Promise.resolve({ data: null, error: { code: 'PGRST202', message: 'not found' } });

/** Answers every query on a table with its rows; records the filters applied. */
function fakeDb(tables: Record<string, unknown[]>, log: string[][], rpc: Rpc = NOT_DEPLOYED): SupabaseClient {
  return {
    rpc,
    from(table: string) {
      const applied: string[] = [table];
      log.push(applied);
      const builder = {
        select: () => builder,
        eq: (c: string, v: unknown) => (applied.push(`eq:${c}=${v}`), builder),
        lt: (c: string, v: unknown) => (applied.push(`lt:${c}<${v}`), builder),
        in: (c: string) => (applied.push(`in:${c}`), builder),
        order: () => builder,
        then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: tables[table] ?? [], error: null }).then(ok),
      };
      return builder;
    },
  } as unknown as SupabaseClient;
}

const QUERY: BankListQuery = { mode: 'all', status: 'all', account: null, search: '', page: 1, pageSize: 25 };

function matchable(id: string, total: number) {
  return { id, file_name: `${id}.pdf`, status: 'approved', supplier_name: 'ספק', invoice_number: id, invoice_date: '2026-09-01', total_amount: total };
}

test('overview via bank_overview(): one RPC, page details from its matchable invoices', async () => {
  const calls: Call[] = [];
  const log: string[][] = [];
  const rpc: Rpc = (fn, args) => {
    calls.push({ fn, args });
    return Promise.resolve({
      data: {
        transactions: [txnRow('t-1', -100), txnRow('t-2', '-50.00', 'manual', 'i-old')],
        total: 2,
        page: 1,
        pageSize: 25,
        totalPages: 1,
        summary: { total: 130_000, debits: 2, matched: 1, missing: 1, missingSum: 100, ignored: 0, accountLabels: ['לאומי'] },
        matchable: [matchable('i-1', 100), matchable('i-2', 100)],
        used_invoice_ids: ['i-2'],
      },
      error: null,
    });
  };
  const db = fakeDb(
    { invoices: [{ id: 'i-old', file_name: 'old.pdf', status: 'pending', validated_data: { supplier_name: 'ישן' }, extracted_data: null }] },
    log,
    rpc
  );
  const overview = await loadBankOverview(db, 'client-1', { ...QUERY, mode: 'missing', search: 'x', account: '' });

  assert.deepEqual(calls, [
    {
      fn: 'bank_overview',
      args: {
        p_client_id: 'client-1',
        p_mode: 'missing',
        p_status: 'all',
        p_account: '',
        p_search: 'x',
        p_page: 1,
        p_page_size: 25,
        p_details: true,
      },
    },
  ]);
  assert.equal(overview.summary.total, 130_000);
  assert.deepEqual(overview.summary.accountLabels, ['לאומי']);
  assert.equal(overview.transactions[1].amount, -50);
  assert.deepEqual(overview.transactions[1].rejected_invoice_ids, []);
  // i-2 is already matched: neither a candidate nor in the picker's list
  assert.deepEqual(overview.candidates, { 't-1': ['i-1'] });
  assert.deepEqual(overview.available.map((i) => i.id), ['i-1']);
  // The matched invoice that isn't matchable any more is looked up for display (the only query)
  assert.deepEqual(overview.invoices.map((i) => i.id), ['i-old']);
  assert.deepEqual(log.map((q) => q[0]), ['invoices']);
});

test('overview linesOnly asks bank_overview() for the lines only', async () => {
  const calls: Call[] = [];
  const rpc: Rpc = (fn, args) => {
    calls.push({ fn, args });
    return Promise.resolve({ data: { transactions: [txnRow('t-1', -100)], total: 1, page: 1, pageSize: 25, totalPages: 1 }, error: null });
  };
  const log: string[][] = [];
  const overview = await loadBankOverview(fakeDb({}, log, rpc), 'client-1', QUERY, { linesOnly: true });
  assert.equal(calls[0].args.p_details, false);
  assert.equal(overview.transactions.length, 1);
  assert.deepEqual(overview.available, []);
  assert.equal(overview.summary.total, 0);
  assert.equal(log.length, 0);
});

test('overview fallback without bank_overview(): filters, pages and summarizes in JS', async () => {
  const db = fakeDb(
    { bank_transactions: [txnRow('t-1', -100), txnRow('t-2', 50), txnRow('t-3', -20, 'ignored')], invoices: [] },
    []
  );
  const overview = await loadBankOverview(db, 'client-1', { ...QUERY, mode: 'missing' });
  assert.deepEqual(overview.transactions.map((t) => t.id), ['t-1']);
  assert.equal(overview.total, 1);
  assert.equal(overview.summary.total, 3);
  assert.equal(overview.summary.missing, 1);
});

test('missing export via bank_missing_lines(): keyset cursor, null after a short page', async () => {
  const calls: Call[] = [];
  const rpc: Rpc = (fn, args) => {
    calls.push({ fn, args });
    const rows = args.p_after
      ? [{ id: 'c', txn_date: '2026-09-01', account_label: '', description: 'd', reference: null, amount: '-3.50' }]
      : Array.from({ length: args.p_limit as number }, (_, i) => ({
          id: `a${i}`,
          txn_date: '2026-09-01',
          account_label: '',
          description: 'd',
          reference: null,
          amount: -1,
        }));
    return Promise.resolve({ data: rows, error: null });
  };
  const db = fakeDb({}, [], rpc);
  const first = await loadMissingExportPage(db, 'client-1', null, 2);
  assert.deepEqual(first.lines.map((l) => l.id), ['a0', 'a1']);
  assert.equal(first.next, 'a1');
  const second = await loadMissingExportPage(db, 'client-1', first.next, 2);
  assert.deepEqual(second.lines, [{ id: 'c', txn_date: '2026-09-01', account_label: '', description: 'd', reference: null, amount: -3.5 }]);
  assert.equal(second.next, null);
  assert.deepEqual(
    calls.map((c) => [c.fn, c.args.p_after, c.args.p_limit]),
    [
      ['bank_missing_lines', null, 2],
      ['bank_missing_lines', 'a1', 2],
    ]
  );
});

test('missing export fallback: unmatched debits only, paged by id here', async () => {
  const log: string[][] = [];
  const db = fakeDb({ bank_transactions: [txnRow('b', -1), txnRow('a', -2), txnRow('c', -3)] }, log);
  const page = await loadMissingExportPage(db, 'client-1', 'a', 1);
  assert.deepEqual(page.lines.map((l) => l.id), ['b']);
  assert.equal(page.next, 'b');
  assert.ok(log[0].includes('eq:match_status=unmatched'));
  assert.ok(log[0].includes('lt:amount<0'));
});

test('the sheet accepts export lines without a match status', () => {
  const rows = missingInvoicesSheetRows([
    { txn_date: '2026-09-02', account_label: 'ויזה', description: 'ב', reference: null, amount: -10 },
    { txn_date: '2026-09-01', account_label: 'ויזה', description: 'א', reference: 'r', amount: -2.5 },
  ]);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[1], ['01/09/2026', 'ויזה', 'א', 'r', 2.5, '']);
  assert.equal(rows[3][4], 12.5);
});
