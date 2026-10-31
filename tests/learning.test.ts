import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExtractedData } from '@/shared/types';
import {
  applyLearnedRules,
  classifyCorrection,
  decideRule,
  formatLearnedHints,
  normalizeAmount,
  normalizeDate,
  normalizeIdentifier,
  normalizeLabel,
  selectRulesForDocument,
  supplierKey,
  valueByRule,
  type LearnedRule,
  type LearningSignal,
} from '@/shared/learning';
import { createFakeDb } from './fakeDb';

process.env.SUPABASE_URL ??= 'https://proj.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://proj.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'test-anon';
const { recordLearningSignals, loadLearnedRules, forgetRule } = await import('@/lib/learning');

// OCR text of QA-p2-v1.png as stored on qa (the model read the invoice number as 30941)
const P2_OCR = [
  'כ"ד )',
  'צ.ל.ה דימונה',
  'N 8p 2015',
  'תחנה מרכזית דימונה, טל. 08-9158964',
  "ח מס' 515312478",
  "חשבונית מס / קבלה מס' 3 0941",
  'נתקבלמ / %558 S58',
  'סהייכ',
  '450',
].join('\n');

// A supplier whose invoices print an order number and a reference ("אסמכתא") side by side
const REF_OCR_1 = [
  'אבגד שירותים בע"מ ח.פ 515312478',
  'הזמנה 7781',
  'אסמכתא 40012',
  'תאריך 03/02/2026',
  'סה"כ לתשלום 1,170.00',
].join('\n');
const REF_OCR_2 = [
  'אבגד שירותים בע"מ ח.פ 515312478',
  'הזמנה 7790',
  'אסמכתא 40057',
  'תאריך 10/03/2026',
  'סה"כ לתשלום 234.00',
].join('\n');

function data(overrides: Partial<ExtractedData> = {}): ExtractedData {
  return {
    supplier_name: 'אבגד שירותים',
    supplier_vat_id: '515312478',
    invoice_number: null,
    invoice_date: null,
    amount_before_vat: null,
    vat_amount: null,
    total_amount: null,
    expense_category: null,
    ...overrides,
  };
}

function rule(overrides: Partial<LearnedRule> = {}): LearnedRule {
  return {
    id: 'r1',
    client_id: 'c1',
    supplier_key: 'vat:515312478',
    supplier_vat_id: '515312478',
    supplier_name: 'אבגד שירותים',
    field: 'invoice_number',
    label: 'אסמכתא',
    wrong_label: 'הזמנה',
    line_offset: 0,
    value_shape: { kind: 'id', length: 5, digitsOnly: true, positionFromEnd: 0 },
    support: 1,
    conflicts: 0,
    active: true,
    last_value: '40012',
    last_wrong_value: '7781',
    ...overrides,
  };
}

describe('normalization', () => {
  test('amounts, dates, identifiers and labels', () => {
    assert.equal(normalizeAmount('1,234.50'), 1234.5);
    assert.equal(normalizeAmount('₪ 450'), 450);
    assert.equal(normalizeAmount(258.171), 258.17);
    assert.equal(normalizeAmount('abc'), null);
    assert.equal(normalizeDate('17/5/24'), '2024-05-17');
    assert.equal(normalizeDate('03.02.2026'), '2026-02-03');
    assert.equal(normalizeDate('2026-02-03'), '2026-02-03');
    assert.equal(normalizeDate('31/02/2026'), null);
    assert.equal(normalizeIdentifier(' 51-234 567 '), '51234567');
    assert.equal(normalizeIdentifier('05891'), '05891', 'leading zeros are part of an identifier');
    assert.equal(normalizeLabel("חשבונית מס / קבלה מס' 3 0941"), 'חשבונית מס קבלה מס');
  });

  test('supplier key: VAT id, else the Hebrew name intact', () => {
    assert.equal(supplierKey('51531247-8', 'x'), 'vat:515312478');
    assert.equal(supplierKey('67929117', null), 'vat:067929117');
    assert.equal(supplierKey(null, ' ״דנן   חלפים" '), 'name:דנן חלפים');
    assert.equal(supplierKey('', ''), null);
  });
});

describe('classifying a correction', () => {
  test('a corrected value printed in the OCR is in_document, with the label next to it', () => {
    const c = classifyCorrection('invoice_number', '30941', '0941', P2_OCR);
    assert.equal(c.classification, 'in_document');
    assert.equal(c.label, 'חשבונית מס קבלה מס');
    assert.equal(c.lineOffset, 0);
    assert.deepEqual(c.shape, { kind: 'id', length: 4, digitsOnly: true, positionFromEnd: 0 });
  });

  test('the label of the wrong value is kept when it differs', () => {
    const c = classifyCorrection('invoice_number', '7781', '40012', REF_OCR_1);
    assert.equal(c.classification, 'in_document');
    assert.equal(c.label, 'אסמכתא');
    assert.equal(c.wrongLabel, 'הזמנה');
  });

  test('amounts and dates are matched after normalization', () => {
    assert.equal(classifyCorrection('total_amount', 1170, '1170', REF_OCR_1).classification, 'in_document');
    const d = classifyCorrection('invoice_date', null, '2026-02-03', REF_OCR_1);
    assert.equal(d.classification, 'in_document');
    assert.equal(d.label, 'תאריך');
  });

  test('values that are not printed are not_in_document', () => {
    assert.equal(classifyCorrection('expense_category', 'אחר', 'נסיעות', P2_OCR).classification, 'not_in_document');
    assert.equal(classifyCorrection('invoice_number', '30941', 'QA-999', P2_OCR).classification, 'not_in_document');
    assert.equal(classifyCorrection('invoice_number', '30941', null, P2_OCR).reason, 'cleared');
    assert.equal(classifyCorrection('invoice_number', '30941', '0941', null).reason, 'no_ocr_text');
  });

  test('one character off a printed value is a reviewer typo', () => {
    assert.equal(classifyCorrection('invoice_number', '30941', '0914', P2_OCR).classification, 'user_typo');
    assert.equal(classifyCorrection('invoice_number', '7781', '40013', REF_OCR_1).classification, 'user_typo');
  });
});

describe('aggregating signals into a rule', () => {
  const sig = (label: string, at: string): LearningSignal => ({
    label,
    value_shape: { kind: 'id', length: 5, digitsOnly: true, positionFromEnd: 0 },
    line_offset: 0,
    corrected_value: '1',
    created_at: at,
  });

  test('one in-document correction creates an active rule', () => {
    const d = decideRule([sig('אסמכתא', '2026-01-01')]);
    assert.equal(d?.label, 'אסמכתא');
    assert.equal(d?.active, true);
    assert.equal(d?.support, 1);
  });

  test('a single contradicting correction does not override an established rule', () => {
    const two = [sig('אסמכתא', '2026-01-01'), sig('אסמכתא', '2026-01-02')];
    const d1 = decideRule([...two, sig('הזמנה', '2026-01-03')], 'אסמכתא');
    assert.equal(d1?.label, 'אסמכתא');
    assert.equal(d1?.active, true);
    assert.equal(d1?.conflicts, 1);
    // Tie: the incumbent label stays but is no longer applied
    const d2 = decideRule([...two, sig('הזמנה', '2026-01-03'), sig('הזמנה', '2026-01-04')], 'אסמכתא');
    assert.equal(d2?.label, 'אסמכתא');
    assert.equal(d2?.active, false);
    // A clear majority switches the rule
    const d3 = decideRule([...two, sig('הזמנה', '2026-01-03'), sig('הזמנה', '2026-01-04'), sig('הזמנה', '2026-01-05')], 'אסמכתא');
    assert.equal(d3?.label, 'הזמנה');
    assert.equal(d3?.active, true);
  });

  test('signals without a label make no rule', () => {
    assert.equal(decideRule([{ label: null, value_shape: null }]), null);
  });
});

describe('applying a learned rule to the next extraction', () => {
  test('the value next to the learned label replaces the model value', () => {
    const r = applyLearnedRules(data({ invoice_number: '7790', bboxes: { invoice_number: { x1: 0, y1: 0, x2: 1, y2: 1 } } }), [rule()], REF_OCR_2, 'T');
    assert.equal(r.data.invoice_number, '40057');
    assert.deepEqual(r.applied, [{ rule_id: 'r1', field: 'invoice_number', from: '7790', to: '40057', label: 'אסמכתא' }]);
    assert.equal(r.data.field_confidence?.invoice_number, 0.9);
    assert.equal(r.data.bboxes?.invoice_number, undefined);
    assert.equal(r.data.learned_rules?.applied_at, 'T');
  });

  test('the p2 receipt: 30941 becomes 0941 (label on the same line as a stray digit)', () => {
    const c = classifyCorrection('invoice_number', '30941', '0941', P2_OCR);
    const d = decideRule([{ label: c.label, value_shape: c.shape, line_offset: c.lineOffset, corrected_value: '0941' }])!;
    const r = applyLearnedRules(data({ invoice_number: '30941' }), [rule({ ...d, wrong_label: null })], P2_OCR);
    assert.equal(r.data.invoice_number, '0941');
  });

  test('a correct model value is left alone (no trace)', () => {
    const input = data({ invoice_number: '40057' });
    const r = applyLearnedRules(input, [rule()], REF_OCR_2);
    assert.equal(r.applied.length, 0);
    assert.equal(r.data, input);
  });

  test('ambiguous label (two different values) changes nothing', () => {
    const ocr = REF_OCR_2 + '\nאסמכתא 40099';
    assert.equal(valueByRule(rule(), ocr), null);
    assert.equal(applyLearnedRules(data({ invoice_number: '7790' }), [rule()], ocr).data.invoice_number, '7790');
  });

  test('inactive rules, other suppliers and missing labels change nothing', () => {
    assert.equal(applyLearnedRules(data({ invoice_number: '7790' }), [rule({ active: false })], REF_OCR_2).applied.length, 0);
    assert.equal(applyLearnedRules(data({ invoice_number: '7790', supplier_vat_id: '067929117' }), [rule()], REF_OCR_2).applied.length, 0);
    assert.equal(applyLearnedRules(data({ invoice_number: '7790' }), [rule()], 'הזמנה 7790').applied.length, 0);
  });

  test('an amount is replaced only when the sums still add up', () => {
    const totalRule = rule({ field: 'total_amount', label: 'סה כ לתשלום', value_shape: { kind: 'amount', positionFromEnd: 0 } });
    assert.equal(valueByRule(totalRule, REF_OCR_2), 234);
    const consistent = applyLearnedRules(data({ total_amount: 200, vat_amount: 34, amount_before_vat: 200 }), [totalRule], REF_OCR_2);
    assert.equal(consistent.data.total_amount, 234);
    const broken = applyLearnedRules(data({ total_amount: 200, vat_amount: 34, amount_before_vat: 166 }), [totalRule], REF_OCR_2);
    assert.equal(broken.applied.length, 0);
  });

  test('rules are picked for documents of their supplier, the client\'s own first', () => {
    const own = rule({ id: 'own', client_id: 'c1', support: 1 });
    const office = rule({ id: 'office', client_id: 'c2', support: 5 });
    const other = rule({ id: 'other', supplier_key: 'vat:067929117', supplier_vat_id: '067929117' });
    assert.deepEqual(selectRulesForDocument([office, own, other], 'c1', REF_OCR_2).map((r) => r.id), ['own']);
    assert.deepEqual(selectRulesForDocument([office, other], 'c1', REF_OCR_2).map((r) => r.id), ['office']);
    const byName = rule({ id: 'name', supplier_key: 'name:אבגד שירותים בעמ', supplier_vat_id: null });
    assert.deepEqual(selectRulesForDocument([byName], 'c1', REF_OCR_2).map((r) => r.id), ['name']);
  });

  test('prompt hints describe where the field is, not its value', () => {
    const text = formatLearnedHints([rule()]);
    assert.match(text, /invoice_number/);
    assert.match(text, /ליד "אסמכתא" ולא ליד "הזמנה"/);
    assert.equal(formatLearnedHints([rule({ active: false })]), '');
  });
});

describe('recording signals and loading rules (DB, office separation)', () => {
  function seed() {
    const db = createFakeDb();
    db.tables.clients = [
      { id: 'cB', org_id: 'orgB' },
      { id: 'cA', org_id: 'orgA' },
    ];
    db.tables.invoices = [
      { id: 'i1', client_id: 'cB', ocr_text: REF_OCR_1 },
      { id: 'i2', client_id: 'cB', ocr_text: REF_OCR_1 },
    ];
    return db;
  }

  test('an in-document correction creates a rule in the office of the client only', async () => {
    const db = seed();
    const out = await recordLearningSignals(db.client, 'i1', {
      clientId: 'cB',
      approvedData: data({ invoice_number: '40012', expense_category: 'נסיעות' }),
      before: data({ invoice_number: '7781' }),
      corrections: [
        { field: 'invoice_number', ai_value: '7781', corrected_value: '40012' },
        { field: 'expense_category', ai_value: 'אחר', corrected_value: 'נסיעות' },
      ],
    });
    assert.deepEqual(out.in_document, ['invoice_number']);
    assert.deepEqual(out.not_in_document, ['expense_category']);
    assert.equal(db.tables.extraction_learning_signals.length, 2);
    const rules = db.tables.extraction_learned_rules;
    assert.equal(rules.length, 1, 'the category correction creates no rule');
    assert.equal(rules[0].org_id, 'orgB');
    assert.equal(rules[0].label, 'אסמכתא');
    assert.equal(rules[0].supplier_name, 'אבגד שירותים');
    rules[0].id = 'rule-1';

    // Office B's client gets the rule for the same supplier's next document; office A's doesn't
    const forB = await loadLearnedRules(db.client, { clientId: 'cB', ocrText: REF_OCR_2 });
    assert.deepEqual(forB.map((r) => r.id), ['rule-1']);
    const forA = await loadLearnedRules(db.client, { clientId: 'cA', ocrText: REF_OCR_2 });
    assert.deepEqual(forA, []);
  });

  test('a not-in-document correction creates no rule; re-approval is idempotent; forget removes the rule', async () => {
    const db = seed();
    await recordLearningSignals(db.client, 'i1', {
      clientId: 'cB',
      approvedData: data({ invoice_number: 'QA-1' }),
      before: data({ invoice_number: '7781' }),
      corrections: [{ field: 'invoice_number', ai_value: '7781', corrected_value: 'QA-1' }],
    });
    assert.equal((db.tables.extraction_learned_rules ?? []).length, 0);

    const approve = () =>
      recordLearningSignals(db.client, 'i2', {
        clientId: 'cB',
        approvedData: data({ invoice_number: '40012' }),
        before: data({ invoice_number: '7781' }),
        corrections: [{ field: 'invoice_number', ai_value: '7781', corrected_value: '40012' }],
      });
    await approve();
    await approve();
    assert.equal(db.tables.extraction_learning_signals.filter((s) => s.invoice_id === 'i2').length, 1);
    assert.equal(db.tables.extraction_learned_rules.length, 1);
    assert.equal(db.tables.extraction_learned_rules[0].support, 1);

    // Re-approved without the correction: the rule loses its only signal and goes away
    await recordLearningSignals(db.client, 'i2', { clientId: 'cB', approvedData: data({ invoice_number: '7781' }), before: data(), corrections: [] });
    assert.equal(db.tables.extraction_learned_rules.length, 0);

    await approve();
    const r = db.tables.extraction_learned_rules[0] as { id: string; org_id: string; client_id: string; supplier_key: string; field: string };
    r.id = 'rule-2';
    await forgetRule(db.client, r);
    assert.equal(db.tables.extraction_learned_rules.length, 0);
    assert.equal(db.tables.extraction_learning_signals.filter((s) => s.field === 'invoice_number' && s.client_id === 'cB').length, 0);
  });

  test('learning never throws (missing table)', async () => {
    const db = createFakeDb({ extraction_learning_signals: ['supplier_key'] });
    db.tables.clients = [{ id: 'cB', org_id: 'orgB' }];
    db.tables.invoices = [{ id: 'i1', client_id: 'cB', ocr_text: REF_OCR_1 }];
    const out = await recordLearningSignals(db.client, 'i1', {
      clientId: 'cB',
      approvedData: data({ invoice_number: '40012' }),
      before: data(),
      corrections: [{ field: 'invoice_number', ai_value: '7781', corrected_value: '40012' }],
    });
    assert.deepEqual(out.rules, []);
  });
});
