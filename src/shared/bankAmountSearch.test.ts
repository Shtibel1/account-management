import { test } from 'node:test';
import assert from 'node:assert/strict';
import { amountMatchesSearch, filterBankTransactions, normalizeAmountSearch } from '@/shared/bankOverview';
import type { BankTransaction } from '@/shared/types';

test('normalizeAmountSearch strips ₪, spaces, commas and a leading minus', () => {
  assert.equal(normalizeAmountSearch('-1,234.56'), '1234.56');
  assert.equal(normalizeAmountSearch('₪ 500.00'), '500.00');
  assert.equal(normalizeAmountSearch('123.40'), '123.40');
  assert.equal(normalizeAmountSearch('123.'), '123.');
  assert.equal(normalizeAmountSearch('אופיס'), null);
  assert.equal(normalizeAmountSearch('-'), null);
  assert.equal(normalizeAmountSearch('12a'), null);
});

test('amounts match the way the table shows them', () => {
  for (const q of ['123', '123.4', '123.40', '-123.40', '₪123.40']) assert.ok(amountMatchesSearch(-123.4, q), q);
  for (const q of ['500', '500.00', '₪500', '₪ 500.00']) assert.ok(amountMatchesSearch(-500, q), q);
  for (const q of ['1,234.56', '-1,234.56', '1234.56', '1234.5']) assert.ok(amountMatchesSearch(-1234.56, q), q);
  assert.ok(!amountMatchesSearch(-123.4, '123.41'));
  assert.ok(!amountMatchesSearch(-500, '500.01'));
  assert.ok(!amountMatchesSearch(-500, 'abc'));
});

test('filterBankTransactions finds "123.40" / "1,234.56" / "500.00"', () => {
  const row = (id: string, amount: number, description = 'x') =>
    ({ id, amount, description, reference: null, account_label: '', match_status: 'unmatched', matched_invoice_id: null }) as unknown as BankTransaction;
  const rows = [row('a', -1234.56), row('b', -123.4), row('c', -500), row('d', 10, 'תשלום 500.00')];
  const find = (search: string) =>
    filterBankTransactions(rows, { mode: 'all', status: 'all', account: null, search }, new Map()).map((t) => t.id).sort();
  assert.deepEqual(find('123'), ['a', 'b']);
  assert.deepEqual(find('123.40'), ['b']);
  assert.deepEqual(find('1,234.56'), ['a']);
  assert.deepEqual(find('500.00'), ['c', 'd']);
});
