import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDb, type FakeDb } from './fakeDb';
import { runProcessingTick, setQueueDepsForTests } from '@/lib/processingQueue';
import type { ExtractedData, OcrWord } from '@/shared/types';

const T0 = Date.parse('2026-10-31T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const DATA = { supplier_name: 'ספק', total_amount: 117, vat_amount: 17, amount_before_vat: 100 } as unknown as ExtractedData;

let db: FakeDb;
let clock: number;

beforeEach(() => {
  db = createFakeDb();
  clock = T0 + 1_000;
});

const words = (page: number, rot?: 180): OcrWord[] =>
  Array.from({ length: 12 }, (_, i) => ({ text: `w${i}`, page, bbox: { x1: 0.1, y1: 0.1, x2: 0.2, y2: 0.12 }, ...(rot ? { rot } : {}) }));

describe('auto-orientation reaches the save step (no extra Vision call)', () => {
  test('finalize gets the whole file\'s page rotations from the OCR words', async () => {
    (db.tables.invoices ??= []).push({
      id: 'inv1', client_id: 'c1', file_url: 'c1/x.pdf', file_name: 'x.pdf', status: 'processing',
      processing_run_id: 'run1', processing_started_at: iso(T0), processing_attempts: 1, processing_stage: 'extract',
      error_message: null, updated_at: iso(T0), created_at: iso(T0),
    });
    (db.tables.processing_jobs ??= []).push({
      invoice_id: 'inv1', run_id: 'run1', client_id: 'c1', file_url: 'c1/x.pdf', mime_type: 'application/pdf',
      stage: 'extract', page_count: 2, pages_done: 2, page_texts: ['עמוד ראשון', 'עמוד שני'],
      ocr_words: [...words(1), ...words(2, 180)], ocr_confidence: 0.9, detected_languages: ['he'], ocr_op_count: 1,
      split_suggestion: null, split_detection_failed: false, split_input_tokens: 0, split_output_tokens: 0,
      extract_state: null, stage_attempts: 0, transient_attempts: 0, retry_at: null, lock_version: 0,
      locked_until: null, last_error: null, updated_at: iso(T0),
    });
    const got: unknown[] = [];
    setQueueDepsForTests({
      db: db.client,
      now: () => clock,
      fetchFile: async () => Buffer.from('%PDF-1.4 test'),
      loadFewShot: async () => ({ examples: [], supplierVatId: null }),
      extract: async () => ({ data: DATA, inputTokens: 10, outputTokens: 5, fewShotInvoiceIds: [] }),
      finalize: async (input) => {
        got.push(input.pageRotations);
        return { outcome: 'saved', status: 'review', saved: true };
      },
      heartbeatMs: 0,
    });
    let r = await runProcessingTick('inv1', { deadline: clock + 23_000 });
    for (let i = 0; i < 5 && r.state === 'pending'; i++) r = await runProcessingTick('inv1', { deadline: clock + 23_000 });
    setQueueDepsForTests(null);
    assert.equal(r.state, 'done');
    assert.deepEqual(got, [{ '2': 180 }]);
  });
});
