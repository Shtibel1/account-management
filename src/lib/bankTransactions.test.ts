import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import { runAutoMatch } from '@/lib/bankTransactions';

const BATCH = 'batch-new';
const OLD_BATCH = 'batch-old';

function line(id: string, amount: number, date: string, description: string, batch = BATCH) {
  return { id, txn_date: date, description, amount, rejected_invoice_ids: [], import_batch_id: batch };
}

function invoice(id: string, total: number, date: string, supplier: string) {
  return { id, file_name: `${id}.pdf`, status: 'approved', supplier_name: supplier, invoice_number: id, invoice_date: date, total_amount: total };
}

interface Call {
  fn: string;
  args: Record<string, unknown>;
}

/** A db with the two auto-match RPCs; `from()` must not be needed on this path. */
function rpcDb(input: unknown, calls: Call[], opts: { applyDelayMs?: number } = {}): SupabaseClient {
  const db = {
    rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ fn, args });
      const run = async () => {
        if (fn === 'bank_auto_match_input') return { data: input, error: null };
        if (fn === 'apply_bank_auto_matches') {
          if (opts.applyDelayMs) await new Promise((r) => setTimeout(r, opts.applyDelayMs));
          return { data: (args.p_matches as unknown[]).length, error: null };
        }
        return { data: null, error: { code: 'PGRST202', message: 'not found' } };
      };
      return { then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => run().then(ok, ko) };
    },
    from() {
      throw new Error('from() should not be used when the RPCs exist');
    },
  };
  return db as unknown as SupabaseClient;
}

test('matches only the candidate lines from one RPC call and stores them in one batch, new batch first', async () => {
  const calls: Call[] = [];
  const db = rpcDb(
    {
      lines: [
        line('t-old', -200, '2026-09-10', 'חברת חשמל', OLD_BATCH),
        line('t-new', -100, '2026-09-05', 'סופר פארם'),
      ],
      invoices: [invoice('i-1', 100, '2026-09-01', 'סופר-פארם'), invoice('i-2', 200, '2026-09-08', 'חברת החשמל')],
      truncated: false,
    },
    calls
  );
  const result = await runAutoMatch(db, 'client-1', { deadline: Date.now() + 20_000, preferBatchId: BATCH });
  assert.deepEqual(result, { matched: 2, ambiguous: 0, complete: true });
  assert.deepEqual(calls.map((c) => c.fn), ['bank_auto_match_input', 'apply_bank_auto_matches']);
  assert.deepEqual(calls[1].args.p_matches, [
    { transaction_id: 't-new', invoice_id: 'i-1' },
    { transaction_id: 't-old', invoice_id: 'i-2' },
  ]);
});

test('a deadline that is (almost) reached skips the run and reports it incomplete', async () => {
  const calls: Call[] = [];
  const db = rpcDb({ lines: [], invoices: [], truncated: false }, calls);
  const result = await runAutoMatch(db, 'client-1', { deadline: Date.now() + 500 });
  assert.deepEqual(result, { matched: 0, ambiguous: 0, complete: false });
  assert.equal(calls.length, 0);
});

test('stops between apply chunks at the deadline', async () => {
  const calls: Call[] = [];
  const lines = [];
  const invoices = [];
  for (let i = 0; i < 1200; i++) {
    // Distinct amounts: every line has exactly one candidate
    lines.push(line(`t-${i}`, -(1000 + i * 3), '2026-09-05', 'ספק'));
    invoices.push(invoice(`i-${i}`, 1000 + i * 3, '2026-09-01', 'ספק'));
  }
  const db = rpcDb({ lines, invoices, truncated: false }, calls, { applyDelayMs: 700 });
  const result = await runAutoMatch(db, 'client-1', { deadline: Date.now() + 2_000 });
  assert.equal(result.complete, false);
  assert.equal(result.matched, 500);
  assert.equal(calls.filter((c) => c.fn === 'apply_bank_auto_matches').length, 1);
});

test('too many candidate lines: nothing is matched, reported incomplete', async () => {
  const calls: Call[] = [];
  const db = rpcDb({ lines: [line('t-1', -100, '2026-09-05', 'x')], invoices: [invoice('i-1', 100, '2026-09-01', 'x')], truncated: true }, calls);
  const result = await runAutoMatch(db, 'client-1', { deadline: Date.now() + 20_000 });
  assert.deepEqual(result, { matched: 0, ambiguous: 0, complete: false });
  assert.deepEqual(calls.map((c) => c.fn), ['bank_auto_match_input']);
});

test('fallback without the RPCs: loads unmatched debits only and updates one by one', async () => {
  const filters: string[][] = [];
  const updates: unknown[] = [];
  const tables: Record<string, unknown[]> = {
    bank_transactions: [
      { ...line('t-1', -100, '2026-09-05', 'סופר פארם'), match_status: 'unmatched', matched_invoice_id: null },
    ],
    invoices: [
      { id: 'i-1', file_name: 'a.pdf', status: 'approved', validated_data: { supplier_name: 'סופר-פארם', invoice_date: '2026-09-01', total_amount: 100 }, extracted_data: null },
    ],
  };
  const db = {
    rpc() {
      return Promise.resolve({ data: null, error: { code: 'PGRST202', message: 'not found' } });
    },
    from(table: string) {
      const applied: string[] = [table];
      filters.push(applied);
      let isUpdate = false;
      const builder = {
        select: () => builder,
        eq: (c: string, v: unknown) => (applied.push(`eq:${c}=${v}`), builder),
        lt: (c: string, v: unknown) => (applied.push(`lt:${c}<${v}`), builder),
        not: (c: string) => (applied.push(`not:${c}`), builder),
        in: () => builder,
        order: () => builder,
        update: (u: unknown) => ((isUpdate = true), updates.push(u), builder),
        then: (ok: (v: unknown) => unknown) => {
          if (isUpdate) return Promise.resolve({ data: null, error: null }).then(ok);
          const rows = applied.some((f) => f.startsWith('not:')) ? [] : tables[table];
          return Promise.resolve({ data: rows, error: null }).then(ok);
        },
      };
      return builder;
    },
  } as unknown as SupabaseClient;
  const result = await runAutoMatch(db, 'client-1', { deadline: Date.now() + 20_000 });
  assert.deepEqual(result, { matched: 1, ambiguous: 0, complete: true });
  const lineQuery = filters.find((f) => f[0] === 'bank_transactions' && f.includes('eq:match_status=unmatched'));
  assert.ok(lineQuery?.includes('lt:amount<0'));
  assert.deepEqual(updates, [{ matched_invoice_id: 'i-1', match_status: 'auto' }]);
});
