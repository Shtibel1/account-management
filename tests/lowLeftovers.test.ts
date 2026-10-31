import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { byCountHe, countHe, invoicesCountHe } from '@/shared/hebrewCount';
import {
  checkInvoiceDateSanity,
  DATE_SANITY_WARNING,
  isImplausibleInvoiceDate,
  referenceDay,
} from '@/shared/dateSanity';
import { liveReviewWarnings, MISSING_DATE_WARNING } from '@/shared/reviewWarnings';
import { autoApproveBlockers } from '@/shared/autoApprove';
import { findSplitNumberBbox } from '@/shared/ocrSplitNumber';
import type { OcrWord } from '@/shared/types';

describe('Hebrew counts', () => {
  test('one: noun first, then the number in the noun gender', () => {
    assert.equal(countHe(1, 'invoice'), 'חשבונית אחת');
    assert.equal(countHe(1, 'transaction'), 'תנועה אחת');
    assert.equal(countHe(1, 'row'), 'שורה אחת');
    assert.equal(countHe(1, 'client'), 'לקוח אחד');
    assert.equal(countHe(1, 'rule'), 'כלל אחד');
    assert.equal(countHe(1, 'document'), 'מסמך אחד');
    assert.equal(countHe(1, 'supplier'), 'ספק אחד');
    assert.equal(countHe(1, 'field'), 'שדה אחד');
  });
  test('two and up (and zero): digit, then the plural', () => {
    assert.equal(countHe(2, 'invoice'), '2 חשבוניות');
    assert.equal(countHe(17, 'client'), '17 לקוחות');
    assert.equal(countHe(3, 'rule'), '3 כללים');
    assert.equal(countHe(5, 'transaction'), '5 תנועות');
    assert.equal(countHe(4, 'document'), '4 מסמכים');
    assert.equal(countHe(0, 'invoice'), '0 חשבוניות');
  });
  test('an adjective agrees with the count', () => {
    assert.equal(countHe(1, 'client', { one: 'פעיל', many: 'פעילים' }), 'לקוח פעיל אחד');
    assert.equal(countHe(3, 'client', { one: 'פעיל', many: 'פעילים' }), '3 לקוחות פעילים');
    assert.equal(countHe(1, 'invoice', { one: 'אפשרית', many: 'אפשריות' }), 'חשבונית אפשרית אחת');
    assert.equal(countHe(1, 'transaction', { one: 'נוספת', many: 'נוספות' }), 'תנועה נוספת אחת');
  });
  test('byCountHe / invoicesCountHe', () => {
    assert.equal(byCountHe(1, 'נבחרה', 'נבחרו'), 'נבחרה');
    assert.equal(byCountHe(2, 'נבחרה', 'נבחרו'), 'נבחרו');
    assert.equal(invoicesCountHe(1), 'חשבונית אחת');
    assert.equal(invoicesCountHe(6), '6 חשבוניות');
  });
});

describe('invoice date sanity', () => {
  const upload = '2026-10-31T20:34:09.440176+00:00';

  test('QA-p2: the "2015" printed on the receipt book is far from the upload date', () => {
    const r = checkInvoiceDateSanity('2015-08-26', upload);
    assert.deepEqual(r, { reason: 'too_old', original: '2015-08-26', reference_date: '2026-10-31' });
  });
  test('the handwritten 3/6/26 is plausible', () => {
    assert.equal(checkInvoiceDateSanity('2026-06-03', upload), null);
  });
  test('future beyond a few days', () => {
    assert.equal(checkInvoiceDateSanity('2026-11-03', upload), null);
    assert.equal(checkInvoiceDateSanity('2026-11-04', upload)?.reason, 'future');
    assert.equal(checkInvoiceDateSanity('2027-06-03', upload)?.reason, 'future');
  });
  test('older than 18 months', () => {
    assert.equal(checkInvoiceDateSanity('2025-04-30', upload), null);
    assert.equal(checkInvoiceDateSanity('2025-04-29', upload)?.reason, 'too_old');
  });
  test('no / unparseable date: nothing to check', () => {
    assert.equal(checkInvoiceDateSanity(null, upload), null);
    assert.equal(checkInvoiceDateSanity('', upload), null);
    assert.equal(checkInvoiceDateSanity('26/08/2015', upload), null);
    assert.equal(checkInvoiceDateSanity('2026-02-31', upload), null);
  });
  test('upload day is taken in Israel time', () => {
    assert.equal(referenceDay('2026-10-31T22:30:00Z'), '2026-11-01');
    assert.equal(referenceDay('2026-10-31T10:00:00Z'), '2026-10-31');
  });
  test('defaults to today', () => {
    assert.equal(isImplausibleInvoiceDate('1999-01-01'), true);
    assert.equal(isImplausibleInvoiceDate(referenceDay(new Date())), false);
  });
});

describe('date warning in the review form (liveReviewWarnings)', () => {
  const base = { amount_before_vat: 100, vat_amount: 18, total_amount: 118, line_items: null };
  const uploaded_at = '2026-10-31';

  test('stays while the date is still implausible', () => {
    const w = liveReviewWarnings([DATE_SANITY_WARNING], { ...base, invoice_date: '2015-08-26', uploaded_at });
    assert.deepEqual(w, [DATE_SANITY_WARNING]);
  });
  test('drops once the reviewer enters a plausible date', () => {
    const w = liveReviewWarnings([DATE_SANITY_WARNING, 'אחר'], { ...base, invoice_date: '2026-06-03', uploaded_at });
    assert.deepEqual(w, ['אחר']);
  });
  test('cleared date: the date warning goes, the missing-date warning is not invented', () => {
    const w: string[] = liveReviewWarnings([DATE_SANITY_WARNING], { ...base, invoice_date: null, uploaded_at });
    assert.equal(w.includes(MISSING_DATE_WARNING), false);
    assert.deepEqual(w, []);
  });
  test('compared with the upload date, not today', () => {
    // Uploaded in 2024: a 2024 date is fine there even though it is old today
    const w = liveReviewWarnings([DATE_SANITY_WARNING], { ...base, invoice_date: '2024-02-01', uploaded_at: '2024-03-01' });
    assert.deepEqual(w, []);
  });
});

test('an implausible date blocks auto-approve', () => {
  const check = {
    supplierVatId: '515312478',
    result: { math_ok: true, vat_id_ok: true, fields_missing: [], rule_violations: [], duplicate_found: false, not_an_invoice: false },
    duplicateCheckRan: true,
    amountsAutoCorrected: false,
  };
  assert.deepEqual(autoApproveBlockers(check), []);
  assert.deepEqual(autoApproveBlockers({ ...check, implausibleDate: true }), ['תאריך החשבונית רחוק מתאריך ההעלאה']);
});

describe('invoice number split over OCR words (QA-p2 highlight)', () => {
  const w = (text: string, x1: number, y1: number, x2: number, y2: number, page = 1): OcrWord => ({ text, bbox: { x1, y1, x2, y2 }, page });
  // "חשבונית מס / קבלה מס' 3 0941" — the red "0941/3" OCR'd as two words, after the label
  const words: OcrWord[] = [
    w('תחנה', 0.62, 0.22, 0.7, 0.25),
    w('08-9158964', 0.22, 0.22, 0.38, 0.25),
    w('חשבונית', 0.78, 0.32, 0.88, 0.35),
    w('מס', 0.72, 0.32, 0.76, 0.35),
    w("מס'", 0.5, 0.32, 0.54, 0.35),
    w('3', 0.44, 0.31, 0.46, 0.35),
    w('0941', 0.33, 0.31, 0.43, 0.35),
    w('515312478', 0.08, 0.27, 0.22, 0.29),
  ];

  test('"30941" (model joined the parts) gets the box of both words', () => {
    assert.deepEqual(findSplitNumberBbox('30941', words), { x1: 0.33, y1: 0.31, x2: 0.46, y2: 0.35, page: 1 });
  });
  test('either order of the parts', () => {
    assert.deepEqual(findSplitNumberBbox('09413', words), { x1: 0.33, y1: 0.31, x2: 0.46, y2: 0.35, page: 1 });
    assert.deepEqual(findSplitNumberBbox('0941/3', words), { x1: 0.33, y1: 0.31, x2: 0.46, y2: 0.35, page: 1 });
  });
  test('no match across lines, labels or short numbers', () => {
    // "0941" + "515312478" are adjacent in the list but not on one line
    assert.equal(findSplitNumberBbox('0941515312478', words), undefined);
    assert.equal(findSplitNumberBbox('12', [w('1', 0, 0, 0.1, 0.1), w('2', 0.1, 0, 0.2, 0.1)]), undefined);
    assert.equal(findSplitNumberBbox('99999', words), undefined);
    assert.equal(findSplitNumberBbox('INV-30941', words), undefined);
    assert.equal(findSplitNumberBbox(null, words), undefined);
  });
});
