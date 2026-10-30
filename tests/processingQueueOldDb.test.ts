// Own file (own process): the queue remembers per process that the migration columns are missing.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDb } from './fakeDb';
import { runProcessingTick, setQueueDepsForTests } from '@/lib/processingQueue';
import type { ExtractedData } from '@/shared/types';

const T0 = Date.parse('2026-10-30T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

afterEach(() => setQueueDepsForTests(null));

test('without migration 20261030191000 a transient failure counts as a real attempt and nothing breaks', async () => {
  const db = createFakeDb({ processing_jobs: ['transient_attempts', 'retry_at'], invoices: ['processing_error_detail'] });
  db.tables.invoices = [{
    id: 'inv1', client_id: 'c1', file_url: 'c1/x.pdf', file_name: 'x.pdf', status: 'processing', processing_run_id: 'run1',
    processing_started_at: iso(T0), processing_attempts: 1, processing_stage: 'extract', updated_at: iso(T0), created_at: iso(T0),
  }];
  db.tables.processing_jobs = [{
    invoice_id: 'inv1', run_id: 'run1', client_id: 'c1', file_url: 'c1/x.pdf', mime_type: 'application/pdf', stage: 'extract',
    page_count: 1, pages_done: 1, page_texts: ['עמוד'], ocr_words: [], ocr_confidence: 0.9, detected_languages: ['he'], ocr_op_count: 1,
    split_suggestion: null, split_detection_failed: false, split_input_tokens: 0, split_output_tokens: 0, extract_state: null,
    stage_attempts: 0, lock_version: 0, locked_until: null, last_error: null, updated_at: iso(T0),
  }];
  const clock = T0 + 1_000;
  setQueueDepsForTests({
    db: db.client,
    now: () => clock,
    fetchFile: async () => Buffer.from('%PDF-1.4'),
    loadFewShot: async () => ({ examples: [], supplierVatId: null }),
    extract: async () => {
      throw new TypeError('fetch failed');
    },
    finalize: async () => ({ outcome: 'saved', status: 'review', saved: true }),
    heartbeatMs: 0,
  });

  const r = await runProcessingTick('inv1', { deadline: clock + 20_000 });
  assert.equal(r.state, 'pending');
  const job = db.tables.processing_jobs[0];
  assert.equal(job.stage_attempts, 1);
  assert.equal(job.locked_until, null);
  assert.equal('transient_attempts' in job, false);

  // ...and a successful step still saves its results
  setQueueDepsForTests({
    db: db.client,
    now: () => clock,
    fetchFile: async () => Buffer.from('%PDF-1.4'),
    loadFewShot: async () => ({ examples: [], supplierVatId: null }),
    extract: async () => ({ data: { supplier_name: 'ספק' } as unknown as ExtractedData, inputTokens: 1, outputTokens: 1, fewShotInvoiceIds: [] }),
    finalize: async () => ({ outcome: 'saved', status: 'review', saved: true }),
    heartbeatMs: 0,
  });
  const done = await runProcessingTick('inv1', { deadline: clock + 20_000 });
  assert.equal(done.state, 'done');
});
