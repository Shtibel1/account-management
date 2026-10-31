import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildCheckSql } from '../scripts/sql-checks/storage-guard.mjs';

const MIGRATION = readFileSync(new URL('../supabase/migrations/20261031110000_qa5_storage_guard.sql', import.meta.url), 'utf8');

// The SQL itself is run against Postgres by hand (see the script; every row came back ok = true on
// 2026-10-31); this keeps the script in step with the migration: the function bodies are found and
// the delete rule reads only the substituted invoices CTE.
test('storage guard SQL check builds from the QA5 migration', () => {
  const sql: string = buildCheckSql();
  assert.match(sql, /regexp_matches\(p, /);
  assert.match(sql, /from inv i/);
  assert.doesNotMatch(sql, /public\./);
  assert.doesNotMatch(sql, /\bobject_name\b/);
  // The rule matches every invoice, not only those of the path's client (QA5 review).
  assert.doesNotMatch(sql, /i\.client_id/);
  for (const name of ['moved', 'failed', 'orig', 'shared', 'unreferenced']) assert.match(sql, new RegExp(`'delete: c1/${name}\.pdf'`));
});

test('the builder refuses a migration whose delete rule filters by client again', () => {
  const filtered = MIGRATION.replace('where i.status::text', 'where i.client_id = public.x() and i.status::text');
  assert.throws(() => buildCheckSql(filtered), /reads another table/);
});

test('browser sessions cannot repoint an invoice file or move it to another client', () => {
  const guard = MIGRATION.slice(MIGRATION.indexOf('create or replace function public.invoices_status_guard()'));
  assert.match(guard, /set search_path = public, pg_temp/);
  for (const col of ['file_url', 'original_file_url', 'client_id']) {
    assert.match(guard, new RegExp(`new\.${col} is distinct from old\.${col}`));
  }
  // The earlier checks are kept.
  for (const col of ['status', 'reviewed_at', 'exported_at', 'validated_data', 'ai_confidence']) {
    assert.match(guard, new RegExp(`new\.${col} is distinct from old\.${col}`));
  }
  assert.match(guard, /app\.invoice_reopen/);
});

test('PATCH /api/invoices/[id] does not let the client set the stored-file references', () => {
  const route = readFileSync(new URL('../src/app/api/invoices/[id]/route.ts', import.meta.url), 'utf8');
  const cols = route.slice(route.indexOf('const PROTECTED_COLUMNS'), route.indexOf('];', route.indexOf('const PROTECTED_COLUMNS')));
  assert.match(cols, /'file_url'/);
  assert.match(cols, /'original_file_url'/);
});
