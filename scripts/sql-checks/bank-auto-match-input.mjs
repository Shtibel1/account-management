// Read-only SQL check of bank_auto_match_input() (migration 20261031100000) against seeded data.
//
// Prints one SELECT that runs the function's body from the migration file on in-query VALUES
// (the tables are replaced by CTEs), four times with different budgets, and compares the result
// with the expected one. It writes nothing and needs no function to be deployed, so it can run on
// any Postgres (e.g. the Supabase SQL editor or execute_sql). Every row must have ok = true.
//   node scripts/sql-checks/bank-auto-match-input.mjs > check.sql
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MIGRATION = fileURLToPath(new URL('../../supabase/migrations/20261031100000_qa4_bank_overview.sql', import.meta.url));

const CLIENT = "'c0000000-0000-0000-0000-000000000000'::uuid";
const BATCH = "'b0000000-0000-0000-0000-000000000000'::uuid";
const OTHER_BATCH = "'b0000000-0000-0000-0000-000000000001'::uuid";
const id = (n) => `'00000000-0000-0000-0000-0000000000${String(n).padStart(2, '0')}'::uuid`;

// Invoices: [id, total, invoice_date, status]
const INVOICES = [
  [1, 100, '2026-01-10', 'approved'],  // lines 16, 17 (shared with 5)
  [2, 200, '2026-01-01', 'approved'],  // lines 11-15: over the per-invoice cap of 3
  [3, 300, '2026-01-10', 'exported'],  // lines 20 (the preferred batch), 21
  [5, 100, '2026-01-12', 'approved'],  // lines 16, 17 (shared with 1)
  [6, 200, '2026-03-30', 'approved'],  // lines 15 (shared with 2), 19
  [7, 400, '2026-01-10', 'approved'],  // lines 22, 23
  [8, 100, '2026-01-10', 'pending'],   // not matchable
];
// Lines (all unmatched debits): [id, amount, txn_date, batch]
const LINES = [
  [11, -200, '2026-01-02'], [12, -200, '2026-01-03'], [13, -200, '2026-01-04'], [14, -200, '2026-01-05'],
  [15, -200, '2026-03-25'], [16, -100, '2026-01-11'], [17, -100.2, '2026-01-13'], [19, -200, '2026-04-10'],
  [20, -300, '2026-01-11', BATCH], [21, -300, '2026-01-12'], [22, -400, '2026-01-11'], [23, -400, '2026-01-12'],
];
// [run, p_max_lines, p_prefer_batch_id, expected "truncated|skipped|invoices|lines (B = blocked)"]
const RUNS = [
  [1, 100, 'null::uuid', 'true|1|01,03,05,06,07|15B,16,17,19,20,21,22,23'], // only the per-invoice cap
  [2, 2, BATCH, 'true|5|03|20,21'],                                        // budget: the batch's invoice first
  [3, 2, 'null::uuid', 'true|5|01|16B,17B'],                               // budget: fewest candidates, then id
  [4, 5, 'null::uuid', 'true|4|01,03|16B,17B,20,21'],
];

export function buildCheckSql(migration = readFileSync(MIGRATION, 'utf8')) {
  const start = migration.indexOf('create or replace function public.bank_auto_match_input');
  if (start < 0) throw new Error('bank_auto_match_input not found in the migration');
  const bodyStart = migration.indexOf('as $$', start) + 'as $$'.length;
  let body = migration.slice(bodyStart, migration.indexOf('$$;', bodyStart)).trim().replace(/;$/, '');

  const invoices = INVOICES.map(
    ([n, total, date, status]) =>
      `(${id(n)}, ${CLIENT}, '${status}', 'f${n}.pdf', 'null'::jsonb, ` +
      `jsonb_build_object('supplier_name', 'S${n}', 'invoice_number', 'N${n}', 'invoice_date', '${date}', 'total_amount', ${total}))`
  ).join(',\n    ');
  const lines = LINES.map(
    ([n, amount, date, batch]) =>
      `(${id(n)}, ${CLIENT}, 'unmatched', ${amount}::numeric, '${date}'::date, ${batch ?? OTHER_BATCH}, 'L${n}', array[]::uuid[], null::uuid)`
  ).join(',\n    ');
  const seed =
    `with invoices_t (id, client_id, status, file_name, validated_data, extracted_data) as (values\n    ${invoices}),\n` +
    `  bt (id, client_id, match_status, amount, txn_date, import_batch_id, description, rejected_invoice_ids, matched_invoice_id) as (values\n    ${lines}),\n` +
    '  inv as (';
  body = body
    .replace(/public\.invoices\b/g, 'invoices_t')
    .replace(/public\.bank_transactions\b/g, 'bt')
    .replace('with inv as (', seed);
  const params = {
    p_client_id: CLIENT,
    p_tolerance: '0.51',
    p_max_lines: 'pr.max_lines',
    p_days_before: '7',
    p_days_after: '90',
    p_max_per_invoice: '3',
    p_prefer_batch_id: 'pr.prefer',
  };
  for (const [name, value] of Object.entries(params)) body = body.replace(new RegExp(`\\b${name}\\b`, 'g'), value);
  if (/\bp_[a-z_]+\b/.test(body)) throw new Error(`unreplaced parameter: ${body.match(/\bp_[a-z_]+\b/)[0]}`);

  const runs = RUNS.map(([run, max, prefer, expected]) => `(${run}, ${max}, ${prefer}, '${expected}')`).join(', ');
  return `-- bank_auto_match_input() check: every row must have ok = true
select pr.run, q.got, pr.expected, q.got = pr.expected as ok
from (values ${runs}) pr (run, max_lines, prefer, expected)
cross join lateral (
  select concat_ws('|',
    r ->> 'truncated',
    r ->> 'skipped_invoices',
    (select string_agg(right(x ->> 'id', 2), ',' order by x ->> 'id') from jsonb_array_elements(r -> 'invoices') x),
    (select string_agg(right(x ->> 'id', 2) || case when (x ->> 'blocked')::boolean then 'B' else '' end, ',' order by x ->> 'id')
       from jsonb_array_elements(r -> 'lines') x)
  ) as got
  from (select (${body}) as r) f
) q
order by pr.run;
`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.stdout.write(buildCheckSql());
}
