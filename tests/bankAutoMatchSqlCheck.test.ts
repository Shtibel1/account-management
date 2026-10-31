import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCheckSql } from '../scripts/sql-checks/bank-auto-match-input.mjs';

// The SQL itself is run against Postgres by hand (see the script); this keeps the script in step
// with the migration: the function body is still found and every parameter gets substituted.
test('bank_auto_match_input SQL check builds from the QA4 migration', () => {
  const sql: string = buildCheckSql();
  assert.match(sql, /blocked_lines as/);
  assert.match(sql, /cross join lateral/);
  assert.doesNotMatch(sql, /public\.(invoices|bank_transactions)\b/);
  assert.doesNotMatch(sql, /\bp_(client_id|tolerance|max_lines|days_before|days_after|max_per_invoice|prefer_batch_id)\b/);
});
