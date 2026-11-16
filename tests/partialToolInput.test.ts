import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateOutputTokens, trimPartialToolInput } from '@/shared/partialToolInput';

describe('trimPartialToolInput', () => {
  test('drops the value that was being written (a cut number or string)', () => {
    assert.deepEqual(trimPartialToolInput({ supplier_name: 'ספק', invoice_number: '12', total_amount: 12 }), { supplier_name: 'ספק', invoice_number: '12' });
  });
  test('in a trailing array only its last element is dropped', () => {
    const r = trimPartialToolInput({ supplier_name: 'ספק', line_items: [{ a: 1 }, { a: 2 }, { a: 3, b: 'x' }] });
    assert.deepEqual(r, { supplier_name: 'ספק', line_items: [{ a: 1 }, { a: 2 }] });
  });
  test('a trailing object loses its last key; a cut bbox is dropped whole', () => {
    assert.deepEqual(trimPartialToolInput({ a: 'x', field_confidence: { a: 0.9, b: 0.8 } }), { a: 'x', field_confidence: { a: 0.9 } });
    assert.deepEqual(trimPartialToolInput({ a: 'x', a_bbox: { x1: 1, y1: 2, x2: 3 } }), { a: 'x' });
  });
  test('nothing usable -> null', () => {
    assert.equal(trimPartialToolInput(null), null);
    assert.equal(trimPartialToolInput({ supplier_name: 'ס' }), null);
    assert.equal(trimPartialToolInput([1, 2]), null);
  });
  test('output token estimate', () => {
    assert.equal(estimateOutputTokens(0), 0);
    assert.equal(estimateOutputTokens(301), 101);
  });
});
