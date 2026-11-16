import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AccountMapping, ExtractedData } from '@/shared/types';
import { reviewFormProposal } from '@/shared/supplierRules';
import { diffCorrections } from '@/lib/corrections';
import { invoicesCountHe, ruleReappliedMessage } from '@/shared/hebrewCount';

const ai: Partial<ExtractedData> = { supplier_name: 'צ.ל.ה דימונה', supplier_vat_id: '515312478', invoice_number: '30941' };
const mapping = (m: Partial<AccountMapping>): AccountMapping => ({ id: 'm1', client_id: 'c1', mapping_type: 'supplier', key: 'x', account_code: '2340', ...m });

describe('the review form substitution is part of the system proposal (not a correction)', () => {
  test('unmapped supplier: "ספקים שונים" accepted as shown -> only the reviewer edit counts', () => {
    const approved = { ...ai, supplier_name: 'ספקים שונים', invoice_number: '0941' };
    const c = diffCorrections(reviewFormProposal(ai, ai, []), approved);
    assert.deepEqual(c.map((x) => x.field), ['invoice_number']);
  });

  test('supplier booked to the catch-all account (rule just created by the form) -> no supplier_name correction', () => {
    const rules = [mapping({ key: 'צ.ל.ה דימונה', account_code: '3499', vat_id: '515312478' })];
    const c = diffCorrections(reviewFormProposal(ai, ai, rules), { ...ai, supplier_name: 'ספקים שונים' });
    assert.deepEqual(c, []);
  });

  test('mapped supplier: the rule name is the proposal; the reviewer renaming it is a correction', () => {
    const rules = [mapping({ key: 'צלה דימונה בע"מ', vat_id: '515312478' })];
    assert.deepEqual(diffCorrections(reviewFormProposal(ai, ai, rules), { ...ai, supplier_name: 'צלה דימונה בע"מ' }), []);
    const c = diffCorrections(reviewFormProposal(ai, ai, rules), { ...ai, supplier_name: 'שם אחר' });
    assert.deepEqual(c, [{ field: 'supplier_name', ai_value: 'צלה דימונה בע"מ', corrected_value: 'שם אחר' }]);
  });

  test('mappings unknown (query failed): falls back to the plain system proposal', () => {
    const c = diffCorrections(reviewFormProposal(ai, ai, null), { ...ai, supplier_name: 'ספקים שונים' });
    assert.deepEqual(c.map((x) => x.field), ['supplier_name']);
  });
});

describe('Hebrew counts', () => {
  test('one invoice is "חשבונית אחת"', () => {
    assert.equal(invoicesCountHe(1), 'חשבונית אחת');
    assert.equal(invoicesCountHe(3), '3 חשבוניות');
    assert.equal(ruleReappliedMessage(1, { others: true }), 'כלל הספק הוחל על חשבונית אחת נוספת הממתינה לבדיקה');
    assert.equal(ruleReappliedMessage(4, { others: true }), 'כלל הספק הוחל על 4 חשבוניות נוספות הממתינות לבדיקה');
    assert.equal(ruleReappliedMessage(1, { plural: true }), 'כללי הספק הוחלו על חשבונית אחת הממתינה לבדיקה');
  });
});
