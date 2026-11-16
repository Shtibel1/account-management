import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExtractedData } from '@/shared/types';
import {
  AMOUNT_SANITY_WARNING_PREFIX,
  amountAppearsInText,
  checkAmountSanity,
  isRoundPlaceholder,
} from '@/shared/amountSanity';
import { isAllocationRequired } from '@/shared/allocation';

// OCR text Google Vision returned for QA-p22-v1.png (handwritten receipt of דנן חלפים, no. 5891, ₪900)
const P22_OCR = `״דנן חלפים"
חלקי חילוף ואביזרי רכב
נית/287/65 איזור תעשיה דימונה, טל. 6559260, 08-6556715
עוסק מורשה מס' 067929117
קבלה/חשבונית מס מס' 2/ 5891
מקור
לכבוד
כמות
-671/20
מחיר יח'
הסכוס
7'258 17/5
FFB7A
פרטיס
773
145899
זייפ
סהייכ
2% מ"מ
לתשלום
אשראי
במאומן בשיק מס'
תאריך
P 17/5/24`;

function invoice(over: Partial<ExtractedData>): ExtractedData {
  return {
    supplier_name: 'ספק',
    supplier_vat_id: null,
    invoice_number: '1',
    invoice_date: '2025-03-01',
    amount_before_vat: null,
    vat_amount: null,
    total_amount: null,
    expense_category: null,
    ...over,
  };
}

describe('amount sanity: the ₪1,000,000 handwritten receipt (QA p22)', () => {
  const extracted = invoice({
    supplier_name: 'דנן חלפים',
    invoice_number: '5891',
    invoice_date: '2024-05-17',
    amount_before_vat: 854101,
    vat_amount: 145899,
    total_amount: 1000000,
    field_confidence: { amount_before_vat: 0.5, vat_amount: 0.6, total_amount: 0.5, supplier_name: 0.9 },
  });

  test('amounts are removed, a Hebrew warning keeps the suggestion, originals are kept', () => {
    const out = checkAmountSanity(extracted, P22_OCR);
    assert.equal(out.result?.action, 'nulled');
    assert.ok(out.result?.reasons.includes('round_placeholder'));
    assert.ok(out.result?.reasons.includes('large_not_in_document'));
    assert.equal(out.data.total_amount, null);
    assert.equal(out.data.amount_before_vat, null);
    assert.equal(out.data.vat_amount, null);
    assert.deepEqual(out.result?.original, { amount_before_vat: 854101, vat_amount: 145899, total_amount: 1000000 });
    assert.ok(out.warning?.startsWith(AMOUNT_SANITY_WARNING_PREFIX));
    assert.ok(out.warning?.includes('יש להזין ידנית'));
    assert.ok(out.warning?.includes('₪1,000,000.00'));
    // Scores of removed values are dropped, others kept
    assert.deepEqual(out.data.field_confidence, { supplier_name: 0.9 });
  });

  test('the rejected amount no longer triggers the allocation-number rule', () => {
    assert.equal(isAllocationRequired(extracted), true);
    assert.equal(isAllocationRequired(checkAmountSanity(extracted, P22_OCR).data), false);
  });

  test('without OCR text, a round low-confidence million is still rejected', () => {
    const out = checkAmountSanity(extracted, null);
    assert.equal(out.result?.action, 'nulled');
    assert.ok(out.result?.reasons.includes('round_placeholder'));
    assert.ok(out.result?.reasons.includes('large_low_confidence'));
  });

  test('the other wrong reading of the same page (258.17, VAT 21%) is kept only as an unconfirmed suggestion', () => {
    const out = checkAmountSanity(
      invoice({
        invoice_date: '2024-05-17',
        amount_before_vat: 213.28,
        vat_amount: 44.89,
        total_amount: 258.17,
        field_confidence: { amount_before_vat: 0.95, vat_amount: 0.85, total_amount: 0.85 },
      }),
      P22_OCR
    );
    assert.equal(out.result?.action, 'unconfirmed');
    assert.deepEqual(out.result?.reasons, ['vat_mismatch_not_in_document']);
    assert.equal(out.data.total_amount, 258.17);
    assert.equal(out.data.field_confidence?.total_amount, 0.4);
    assert.ok(out.warning?.startsWith(AMOUNT_SANITY_WARNING_PREFIX));
  });
});

test('QA p22 third reading (627.11 + 145.89 = 773 from the OCR noise "773" / "145899") is unconfirmed', () => {
  const out = checkAmountSanity(
    invoice({ invoice_date: '2024-05-17', amount_before_vat: 627.11, vat_amount: 145.89, total_amount: 773 }),
    P22_OCR
  );
  assert.equal(out.result?.action, 'unconfirmed');
  assert.equal(out.data.total_amount, 773);
});

describe('amount sanity: valid invoices are not flagged', () => {
  test('a large ₪120,000 invoice with 18% VAT printed in the document', () => {
    const ocr = `חברת דוגמה בע"מ ח.פ. 514713288\nחשבונית מס 1042\nתאריך 12/03/2025\nשירותי ייעוץ 101,694.92\nמע"מ 18% 18,305.08\nסה"כ לתשלום 120,000.00 ₪`;
    const data = invoice({
      amount_before_vat: 101694.92,
      vat_amount: 18305.08,
      total_amount: 120000,
      allocation_number: '123456789',
      field_confidence: { amount_before_vat: 0.95, vat_amount: 0.95, total_amount: 0.95 },
    });
    const out = checkAmountSanity(data, ocr);
    assert.equal(out.result, null);
    assert.equal(out.warning, null);
    assert.equal(out.data, data);
  });

  test('a large invoice whose total is printed with spaces / without decimals', () => {
    const ocr = `קבלן שיפוצים\nחשבונית מס 77\nסה"כ לפני מע"מ 50 000\nמע"מ 9 000\nסה"כ 59 000 ש"ח\nתודה`;
    const out = checkAmountSanity(invoice({ amount_before_vat: 50000, vat_amount: 9000, total_amount: 59000 }), ocr);
    assert.equal(out.result, null);
  });

  test('a small exempt receipt (450 / 0 / 450) is untouched', () => {
    const ocr = `צ.ל.ה דימונה\nקבלה מס' 3321\nתאריך 26/08/2015\nסה"כ 450 ש"ח\nעוסק פטור`;
    const data = invoice({ invoice_date: '2015-08-26', amount_before_vat: 450, vat_amount: 0, total_amount: 450 });
    assert.equal(checkAmountSanity(data, ocr).result, null);
    // Even if the OCR missed the number: small amounts with no VAT inconsistency are left alone
    assert.equal(checkAmountSanity(data, 'צ.ל.ה דימונה קבלה מס 3321 תאריך 26/08/2015 עוסק פטור').result, null);
  });

  test('a large total computed from a printed pre-VAT amount is backed by the document', () => {
    const ocr = `ספק ציוד בע"מ\nחשבונית 99\nסכום לפני מע"מ 20,000.00\nמע"מ 18%\nתאריך 01/02/2025`;
    const out = checkAmountSanity(invoice({ amount_before_vat: 20000, vat_amount: 3600, total_amount: 23600 }), ocr);
    assert.equal(out.result, null);
  });

  test('a printed round 100,000 at high confidence is fine', () => {
    const ocr = `נדל"ן בע"מ\nחשבונית מס 5\nלפני מע"מ 84,745.76 מע"מ 15,254.24\nסה"כ 100,000.00\n01/03/2025`;
    const out = checkAmountSanity(
      invoice({ amount_before_vat: 84745.76, vat_amount: 15254.24, total_amount: 100000, field_confidence: { total_amount: 0.95 } }),
      ocr
    );
    assert.equal(out.result, null);
  });
});

describe('amount sanity: VAT mismatch', () => {
  const ocr = `מסעדת הדוגמה\nחשבונית מס 12\nתאריך 05/05/2025\nארוחה עסקית\nתודה ולהתראות 0501234567`;

  test('VAT far from 18% on amounts the document does not show -> unconfirmed with warning', () => {
    const out = checkAmountSanity(
      invoice({ invoice_date: '2025-05-05', amount_before_vat: 1000, vat_amount: 500, total_amount: 1500 }),
      ocr
    );
    assert.equal(out.result?.action, 'unconfirmed');
    assert.deepEqual(out.result?.reasons, ['vat_mismatch_not_in_document']);
    assert.equal(out.data.vat_amount, 500);
    assert.equal(out.data.field_confidence?.vat_amount, 0.4);
    assert.ok(out.warning?.includes('₪1,500.00'));
  });

  test('VAT mismatch on amounts that ARE printed is left to the existing VAT-rate warning', () => {
    const printed = `${ocr}\nסה"כ 1,500.00 מע"מ 500.00 לפני מע"מ 1,000.00`;
    const out = checkAmountSanity(
      invoice({ invoice_date: '2025-05-05', amount_before_vat: 1000, vat_amount: 500, total_amount: 1500 }),
      printed
    );
    assert.equal(out.result, null);
  });

  test('17% on a 2024 invoice is a correct rate (no flag even if not printed)', () => {
    const out = checkAmountSanity(
      invoice({ invoice_date: '2024-05-17', amount_before_vat: 769.23, vat_amount: 130.77, total_amount: 900 }),
      ocr
    );
    assert.equal(out.result, null);
  });
});

describe('amountAppearsInText', () => {
  test('formats', () => {
    assert.equal(amountAppearsInText(120000, 'סה"כ 120,000.00'), true);
    assert.equal(amountAppearsInText(120000, 'סה"כ ₪120000'), true);
    assert.equal(amountAppearsInText(120000, 'סה"כ 120.000,00'), true);
    assert.equal(amountAppearsInText(258.17, '7\'258 17/5'), false);
    assert.equal(amountAppearsInText(1000000, '145899 1000'), false);
    assert.equal(amountAppearsInText(145899, '773\n145899\n'), true);
    assert.equal(amountAppearsInText(120000, '1,120,000.00'), false);
    assert.equal(amountAppearsInText(120000, '120,000.50'), false);
    assert.equal(amountAppearsInText(12.5, 'total 12.50'), true);
    assert.equal(amountAppearsInText(-450, 'זיכוי 450.00-'), true);
  });

  test('round placeholders', () => {
    assert.equal(isRoundPlaceholder(1000000), true);
    assert.equal(isRoundPlaceholder(999999), true);
    assert.equal(isRoundPlaceholder(100000), true);
    assert.equal(isRoundPlaceholder(120000), false);
    assert.equal(isRoundPlaceholder(10000), false);
    assert.equal(isRoundPlaceholder(1000000.5), false);
  });
});
