// Read-only SQL check of the storage guard helpers (migration 20261031110000): percent-decoding,
// the object path of a stored file_url and the delete rule of can_delete_storage_object().
//
// Prints one SELECT that runs the function bodies from the migration file on in-query VALUES (the
// invoices table is replaced by a CTE, the office check by true). It writes nothing and needs no
// function to be deployed, so it can run on any Postgres (e.g. the Supabase SQL editor or
// execute_sql). Every row must have ok = true.
//   node scripts/sql-checks/storage-guard.mjs > check.sql
// Run with execute_sql on 2026-10-31 (before the migration was applied): every row ok = true.
// Not covered here: bytes that aren't valid UTF-8 (e.g. %FF) make storage_path_decode_strict()
// raise, which the plpgsql wrapper storage_path_decode() turns into "return the input as is".
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MIGRATION = fileURLToPath(new URL('../../supabase/migrations/20261031110000_qa5_storage_guard.sql', import.meta.url));

const BASE = 'https://example.supabase.co/storage/v1/object';
const enc = (path) => path.split('/').map(encodeURIComponent).join('/');
const lit = (v) => (v === null ? 'null::text' : `'${String(v).replace(/'/g, "''")}'::text`);

const HEBREW = 'c1/חשבונית מרץ (2).pdf';

// [label, input, expected]
const DECODE = [
  ['space', 'a%20b', 'a b'],
  ['hebrew', enc(HEBREW), HEBREW],
  ['no percent', 'c1/x.pdf', 'c1/x.pdf'],
  ['malformed %zz and trailing %4', 'a%zz%4', 'a%zz%4'],
  ['lone trailing %', '100%', '100%'],
  ['lower-case hex', '%d7%a9', 'ש'],
  ['null', null, null],
];
const PATHS = [
  ['authenticated, hebrew', `${BASE}/authenticated/raw-invoices/${enc(HEBREW)}`, HEBREW],
  ['sign with ?token=', `${BASE}/sign/raw-invoices/${enc('c1/a b.pdf')}?token=eyJabc.def`, 'c1/a b.pdf'],
  ['public', `${BASE}/public/raw-invoices/c1/p.pdf`, 'c1/p.pdf'],
  ['fragment', `${BASE}/authenticated/raw-invoices/c1/f.pdf#page=2`, 'c1/f.pdf'],
  ['other bucket', `${BASE}/authenticated/other-bucket/c1/x.pdf`, null],
  ['mock upload path', '/uploads/raw-invoices/c1/x.pdf', null],
  ['bare object path', 'c1/x.pdf', null],
  ['null', null, null],
];
// Invoices: [id, client_id, status, file_url, original_file_url]
const ref = (path) => `${BASE}/authenticated/raw-invoices/${enc(path)}`;
const INVOICES = [
  ['i1', 'c2', 'approved', ref('c1/moved.pdf'), null],           // moved to another client: still blocks
  ['i2', 'c1', 'error', ref('c1/failed.pdf'), null],             // only an error invoice: deletable
  ['i3', 'c1', 'exported', ref('c1/part-1.pdf'), ref('c1/orig.pdf')], // split part: its original blocks
  ['i4', 'c1', 'review', `${BASE}/sign/raw-invoices/${enc(HEBREW)}?token=t`, null],
  ['i5', 'c1', 'error', ref('c1/shared.pdf'), null],
  ['i6', 'c1', 'returned', ref('c1/shared.pdf'), null],          // shared with an error invoice: blocks
];
// [object name, may delete]
const DELETES = [
  ['c1/moved.pdf', false],
  ['c1/failed.pdf', true],
  ['c1/part-1.pdf', false],
  ['c1/orig.pdf', false],
  [HEBREW, false],
  ['c1/shared.pdf', false],
  ['c1/unreferenced.pdf', true],
];

function functionBody(migration, name) {
  const start = migration.indexOf(`create or replace function public.${name}(`);
  if (start < 0) throw new Error(`${name} not found in the migration`);
  const bodyStart = migration.indexOf('as $$', start) + 'as $$'.length;
  return migration.slice(bodyStart, migration.indexOf('$$;', bodyStart)).trim();
}

export function buildCheckSql(migration = readFileSync(MIGRATION, 'utf8')) {
  const strict = functionBody(migration, 'storage_path_decode_strict');
  if (!/^select\b/.test(strict)) throw new Error('storage_path_decode_strict is not a single select');

  const pathBody = functionBody(migration, 'invoice_file_object_path');
  const pattern = /substring\(p_url from ('(?:[^']|'')*')\)/.exec(pathBody);
  if (!pattern) throw new Error('invoice_file_object_path pattern not found');
  if (!pathBody.includes('public.storage_path_decode(')) throw new Error('invoice_file_object_path no longer decodes');
  const urlPath = (arg) => `substring((${arg}) from ${pattern[1]})`;

  // Every string to decode is decoded once in dec(inp, outp), the way storage_path_decode() does:
  // input without '%' (or null) as is, else the strict decoding. The checks look results up there.
  const decoded = (arg) => `(select d.outp from dec d where d.inp is not distinct from (${arg}) limit 1)`;
  const objectPath = (arg) => decoded(urlPath(arg));

  const canDelete = functionBody(migration, 'can_delete_storage_object');
  const exists = /not exists \(([\s\S]*)\)\s*$/.exec(canDelete);
  if (!exists) throw new Error('can_delete_storage_object: not exists (...) not found');
  let rule = exists[1].replace('from public.invoices i', 'from inv i');
  for (const col of ['file_url', 'original_file_url']) {
    const call = `public.invoice_file_object_path(i.${col})`;
    if (!rule.includes(call)) throw new Error(`can_delete_storage_object no longer checks ${col}`);
    rule = rule.split(call).join(objectPath(`i.${col}`));
  }
  if (rule.includes('public.')) throw new Error('can_delete_storage_object reads another table');

  const invoices = INVOICES.map(
    ([id, client, status, file, original]) => `(${lit(id)}, ${lit(client)}, ${lit(status)}, ${lit(file)}, ${lit(original)})`
  ).join(',\n    ');
  const urls = [...PATHS.map(([, input]) => input), ...INVOICES.flatMap(([, , , file, original]) => [file, original])];
  const rows = [
    ...DECODE.map(([label, input, expected]) => `select 'decode: ${label}' as check_name, ${decoded(lit(input))} as got, ${lit(expected)} as expected`),
    ...PATHS.map(([label, input, expected]) => `select 'path: ${label}', ${objectPath(lit(input))}, ${lit(expected)}`),
    ...DELETES.map(([name, expected]) =>
      `select 'delete: ${name.replace(/'/g, "''")}', (not exists (${rule.replace(/object_name/g, lit(name))}))::text, '${expected}'`),
  ];
  return (
    `with inv (id, client_id, status, file_url, original_file_url) as (values\n    ${invoices}),\n` +
    `raw (inp) as (values ${DECODE.map(([, input]) => `(${lit(input)})`).join(', ')}\n` +
    `  union all select ${urlPath('u.url')} from (values ${urls.map((u) => `(${lit(u)})`).join(', ')}) u(url)),\n` +
    'dec (inp, outp) as (\n' +
    "  select r.inp, case when r.inp is null or position('%' in r.inp) = 0 then r.inp\n" +
    `    else (select _d.v from (select r.inp as p) _p, lateral (${strict}) as _d(v)) end\n` +
    '  from raw r),\n' +
    `cases (check_name, got, expected) as (\n  ${rows.join('\n  union all\n  ')}\n)\n` +
    'select check_name, got, expected, got is not distinct from expected as ok from cases order by ok, check_name;'
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.stdout.write(buildCheckSql() + '\n');
}
