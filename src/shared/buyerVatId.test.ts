import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkSupplierVatId,
  findVatIdOccurrences,
  findVatIdOccurrencesFromWords,
  supplierVatIdWarning,
} from '@/shared/buyerVatId';
import type { OcrWord } from '@/shared/types';

// QA round 3 sample: the model took the buyer's ID (517092433, under "ח.פ לקוח"); the issuer's
// ח.פ. 511863805 was misread in the footer (511803805, checksum invalid) and its label lost (":o:").
// 311057368 is a transaction number in a line item that happens to pass the checksum.
const QA_OCR = [
  'כביש 6 חוצה צפון בע"מ',
  'חשבונית מס / קבלה 4471',
  'לכבוד: חברת הדוגמה בע"מ',
  'ח.פ לקוח 517092433',
  'נסיעות כביש 6 - מספר עסקה 311057368   45.20',
  'סה"כ לתשלום 45.20',
  '557976028 :o: 511803805',
].join('\n');
const QA_LINE_ITEMS = ['נסיעות כביש 6 - מספר עסקה 311057368'];

test('a transaction number next to "מספר עסקה" is not an issuer ID', () => {
  const occ = findVatIdOccurrences('נסיעות כביש 6 - מספר עסקה 311057368');
  assert.deepEqual(occ, [{ vatId: '311057368', buyerLabelled: false, issuerLabelled: false }]);
});

test('issuer labels: before the number wins, the nearest label decides', () => {
  const [a] = findVatIdOccurrences('עוסק מורשה: 511863805 טל: 03-1234567');
  assert.equal(a.issuerLabelled, true);
  const [b] = findVatIdOccurrences('מספר עסקה 311057368 ח.פ');
  assert.equal(b.issuerLabelled, false);
  const [c] = findVatIdOccurrences('511863805 :ח.פ');
  assert.equal(c.issuerLabelled, true);
  const [d] = findVatIdOccurrences('אסמכתא 311057368');
  assert.equal(d.issuerLabelled, false);
});

test('QA case: buyer ID is replaced by the registrar ID, never by the transaction number', () => {
  const check = checkSupplierVatId({
    vatId: '517092433',
    ocrText: QA_OCR,
    lineItemTexts: QA_LINE_ITEMS,
    referenceIds: [null, '511863805'],
  });
  assert.equal(check.reason, 'buyer_label');
  assert.equal(check.vatId, '511863805');
  assert.equal(check.replacementSource, 'reference');
  const warning = supplierVatIdWarning('517092433', check) ?? '';
  assert.ok(!warning.includes('שמופיע בפרטי המנפיק'), warning);
  assert.ok(warning.includes('511863805'));
});

test('QA case without a registrar hit: the ID is removed (not swapped for 311057368)', () => {
  const check = checkSupplierVatId({ vatId: '517092433', ocrText: QA_OCR, lineItemTexts: QA_LINE_ITEMS });
  assert.equal(check.reason, 'buyer_label');
  assert.equal(check.vatId, null);
  assert.equal(check.replacement, null);
  assert.equal(check.replacementSource, null);
  const warning = supplierVatIdWarning('517092433', check) ?? '';
  assert.ok(warning.includes('הוסר'));
  assert.ok(!warning.includes('שמופיע בפרטי המנפיק'));
});

test('the transaction number is excluded even without its label when it is in a line item', () => {
  const ocr = ['ח.פ לקוח 517092433', 'נסיעות 311057368'].join('\n');
  const check = checkSupplierVatId({ vatId: '517092433', ocrText: ocr, lineItemTexts: ['נסיעות 311057368'] });
  assert.equal(check.vatId, null);
});

test('an unlabelled checksum-valid number is no longer taken as the issuer ID', () => {
  const ocr = ['ח.פ לקוח 517092433', 'הוראת קבע 311057368'].join('\n');
  const check = checkSupplierVatId({ vatId: '517092433', ocrText: ocr });
  assert.equal(check.vatId, null);
});

test('an issuer-labelled ID is preferred over the reference IDs and keeps the issuer wording', () => {
  const ocr = ['ח.פ: 511863805', 'לכבוד: חברת הדוגמה', 'ח.פ לקוח 517092433', 'מספר עסקה 311057368'].join('\n');
  const check = checkSupplierVatId({ vatId: '517092433', ocrText: ocr, referenceIds: ['513000005'] });
  assert.equal(check.vatId, '511863805');
  assert.equal(check.replacementSource, 'issuer_label');
  assert.ok((supplierVatIdWarning('517092433', check) ?? '').includes('שמופיע בפרטי המנפיק'));
});

test('a reference ID equal to the buyer ID is never used', () => {
  const check = checkSupplierVatId({ vatId: '517092433', ocrText: QA_OCR, referenceIds: ['517092433'] });
  assert.equal(check.vatId, null);
});

test('client-own ID with an issuer-labelled ID on the page', () => {
  const ocr = ['עוסק מורשה 511863805', 'לקוח: 517092433'].join('\n');
  const check = checkSupplierVatId({ vatId: '517092433', ocrText: ocr, clientOwnIds: ['517092433'] });
  assert.equal(check.reason, 'client_own');
  assert.equal(check.vatId, '511863805');
});

test('an ID that is not the buyer\'s is left alone', () => {
  const check = checkSupplierVatId({ vatId: '511863805', ocrText: 'ח.פ 511863805\nמספר עסקה 311057368' });
  assert.equal(check.reason, null);
  assert.equal(check.vatId, '511863805');
});

// Word boxes of one RTL line, right to left (normalized page coordinates)
function line(y: number, texts: string[]): OcrWord[] {
  let x = 0.9;
  return texts.map((text) => {
    const width = 0.012 * text.length;
    const word = { text, page: 1, bbox: { x1: x - width, y1: y, x2: x, y2: y + 0.015 } };
    x -= width + 0.01;
    return word;
  });
}

test('word layout: issuer label vs. transaction label next to a number', () => {
  const words = [
    ...line(0.1, ['עוסק', 'מורשה', '511863805']),
    ...line(0.5, ['מספר', 'עסקה', '311057368']),
  ];
  const occ = findVatIdOccurrencesFromWords(words);
  assert.equal(occ.find((o) => o.vatId === '511863805')?.issuerLabelled, true);
  assert.equal(occ.find((o) => o.vatId === '311057368')?.issuerLabelled, false);
});
