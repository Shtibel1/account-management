// QA round 4 queue findings: lost 'queued' jobs are requeued (#3), causes pick the stuck message (#5),
// damaged PDFs fail at once (#4), due jobs report what becomes due soon (#6).
import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDb, type FakeDb } from './fakeDb';
import { dueJobs, runProcessingTick, setQueueDepsForTests, sweepStaleProcessing } from '@/lib/processingQueue';
import {
  DUE_SOON_MS,
  ENQUEUE_GRACE_MS,
  LOST_JOB_MESSAGE,
  MAX_LOST_JOB_REQUEUES,
  MAX_RUN_MS,
  STUCK_LONG_RUN_MESSAGE,
  STUCK_RUN_MESSAGE,
} from '@/shared/processing';
import { DAMAGED_PDF_MESSAGE } from '@/shared/uploadValidation';
import type { ExtractedData } from '@/shared/types';

const T0 = Date.parse('2026-10-31T10:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n%%EOF\n');
const DATA = { supplier_name: 'ספק', total_amount: 117, vat_amount: 17, amount_before_vat: 100 } as unknown as ExtractedData;

let db: FakeDb;
let clock: number;
let ocrCalls: number;

function seedInvoice(over: Record<string, unknown> = {}) {
  const row = {
    id: 'inv1',
    client_id: 'c1',
    file_url: 'c1/x.pdf',
    file_name: 'x.pdf',
    status: 'processing',
    processing_run_id: 'run1',
    processing_started_at: iso(T0),
    processing_attempts: 1,
    processing_stage: 'queued',
    processing_progress: { pages_done: 0, pages_total: null },
    error_message: null,
    updated_at: iso(T0),
    created_at: iso(T0),
    ...over,
  };
  (db.tables.invoices ??= []).push(row);
  return row;
}

function seedJob(over: Record<string, unknown> = {}) {
  const row = {
    invoice_id: 'inv1',
    run_id: 'run1',
    client_id: 'c1',
    file_url: 'c1/x.pdf',
    mime_type: 'application/pdf',
    stage: 'ocr',
    page_count: null,
    pages_done: 0,
    page_texts: [],
    ocr_words: [],
    ocr_confidence: null,
    detected_languages: null,
    ocr_op_count: 0,
    split_suggestion: null,
    split_detection_failed: false,
    split_input_tokens: 0,
    split_output_tokens: 0,
    extract_state: null,
    stage_attempts: 0,
    transient_attempts: 0,
    retry_at: null,
    lock_version: 0,
    locked_until: null,
    last_error: null,
    updated_at: iso(T0),
    ...over,
  };
  (db.tables.processing_jobs ??= []).push(row);
  return row;
}

const job = (id = 'inv1') => db.tables.processing_jobs?.find((j) => j.invoice_id === id) as Record<string, unknown> | undefined;
const invoice = (id = 'inv1') => db.tables.invoices.find((i) => i.id === id) as Record<string, unknown>;

function useDeps(loadPdf: () => Promise<{ getPageCount(): number } | null>) {
  setQueueDepsForTests({
    db: db.client,
    now: () => clock,
    fetchFile: async () => PDF,
    loadPdf,
    ocrPdfPages: async (_file, _pdf, pages) => {
      ocrCalls++;
      return { pageTexts: pages.map(() => 'טקסט'), ocrWords: [] };
    },
    loadFewShot: async () => ({ examples: [], supplierVatId: null }),
    extract: async () => ({ data: DATA, inputTokens: 1, outputTokens: 1, fewShotInvoiceIds: [] }),
    finalize: async () => ({ outcome: 'saved', status: 'review', saved: true }),
    heartbeatMs: 0,
  });
}

beforeEach(() => {
  db = createFakeDb();
  clock = T0 + 1_000;
  ocrCalls = 0;
  useDeps(async () => ({ getPageCount: () => 1 }));
});

afterEach(() => setQueueDepsForTests(null));

describe('a queued run whose job row vanished (#3)', () => {
  test('a tick queues it again once the enqueue grace is over, counting the requeue', async () => {
    seedInvoice();
    clock = T0 + ENQUEUE_GRACE_MS + 1_000;
    const r = await runProcessingTick('inv1', { deadline: clock + 20_000 });
    assert.equal(r.state, 'pending');
    assert.equal(invoice().status, 'processing');
    assert.equal(invoice().processing_attempts, 2);
    assert.notEqual(invoice().processing_run_id, 'run1');
    assert.equal((invoice().processing_progress as { requeues?: number }).requeues, 1);
    assert.equal(job()?.run_id, invoice().processing_run_id);
  });

  test('within the grace it waits', async () => {
    seedInvoice({ updated_at: iso(clock - 5_000), processing_started_at: iso(clock - 5_000) });
    const r = await runProcessingTick('inv1', { deadline: clock + 20_000 });
    assert.equal(r.state, 'waiting');
    assert.equal(job(), undefined);
  });

  test('after MAX_LOST_JOB_REQUEUES it fails with the lost-job message (no split hint)', async () => {
    seedInvoice({ processing_progress: { pages_done: 0, pages_total: null, requeues: MAX_LOST_JOB_REQUEUES } });
    clock = T0 + ENQUEUE_GRACE_MS + 1_000;
    const r = await runProcessingTick('inv1', { deadline: clock + 20_000 });
    assert.equal(r.state, 'failed');
    assert.equal(invoice().status, 'error');
    assert.equal(invoice().error_message, LOST_JOB_MESSAGE);
    assert.match(String(invoice().processing_error_detail), /vanished before any step ran/);
  });

  test('the sweep finds it a minute after its enqueue, not after 10 minutes', async () => {
    seedInvoice({ id: 'lostq', updated_at: iso(T0 - ENQUEUE_GRACE_MS - 1_000), processing_started_at: iso(T0 - ENQUEUE_GRACE_MS - 1_000) });
    seedInvoice({ id: 'live', processing_run_id: 'r-live', updated_at: iso(T0 - ENQUEUE_GRACE_MS - 1_000) });
    seedJob({ invoice_id: 'live', run_id: 'r-live' });
    const result = await sweepStaleProcessing(null);
    assert.deepEqual(result.enqueued, ['lostq']);
    assert.deepEqual(result.failed, []);
    assert.equal(invoice('live').processing_run_id, 'r-live');
  });

  test('a backlog of live queued jobs beyond the limit does not hide a lost one (review)', async () => {
    for (let i = 0; i < 5; i++) {
      seedInvoice({ id: `live${i}`, processing_run_id: `r${i}`, updated_at: iso(T0 - ENQUEUE_GRACE_MS - 60_000 + i * 1_000) });
      seedJob({ invoice_id: `live${i}`, run_id: `r${i}` });
    }
    seedInvoice({ id: 'lostq', updated_at: iso(T0 - ENQUEUE_GRACE_MS - 1_000), processing_started_at: iso(T0 - ENQUEUE_GRACE_MS - 1_000) });
    const result = await sweepStaleProcessing(null, 2);
    assert.deepEqual(result.enqueued, ['lostq']);
    assert.deepEqual(result.failed, []);
    assert.equal(job('lostq')?.run_id, invoice('lostq').processing_run_id);
  });
});

describe('stuck-run messages depend on the cause (#5)', () => {
  test('a one-page run that ran too long is not told to split', async () => {
    seedInvoice({ processing_stage: 'ocr', processing_started_at: iso(T0 - MAX_RUN_MS - 1_000) });
    seedJob({ page_count: 1 });
    await runProcessingTick('inv1', { deadline: clock + 20_000 });
    assert.equal(invoice().error_message, STUCK_RUN_MESSAGE);
  });

  test('a long document that ran too long gets the split hint', async () => {
    seedInvoice({ processing_stage: 'ocr', processing_started_at: iso(T0 - MAX_RUN_MS - 1_000) });
    seedJob({ page_count: 25 });
    await runProcessingTick('inv1', { deadline: clock + 20_000 });
    assert.equal(invoice().error_message, STUCK_LONG_RUN_MESSAGE);
  });
});

describe('damaged PDF (#4)', () => {
  test('a PDF whose page tree pdf-lib cannot read fails at once, without retries', async () => {
    useDeps(async () => ({
      getPageCount: () => {
        throw new TypeError("Cannot read properties of undefined (reading 'Pages')");
      },
    }));
    seedInvoice({ processing_stage: 'ocr' });
    seedJob();
    const r = await runProcessingTick('inv1', { deadline: clock + 20_000 });
    assert.equal(r.state, 'failed');
    assert.equal(invoice().status, 'error');
    assert.equal(invoice().error_message, DAMAGED_PDF_MESSAGE);
    assert.equal(ocrCalls, 0);
  });

  test('a PDF header followed by garbage never reaches pdf-lib or OCR', async () => {
    let loads = 0;
    setQueueDepsForTests({
      db: db.client,
      now: () => clock,
      fetchFile: async () => Buffer.from('%PDF-garbage-garbage-garbage!!'),
      loadPdf: async () => {
        loads++;
        return null;
      },
      loadFewShot: async () => ({ examples: [], supplierVatId: null }),
      extract: async () => ({ data: DATA, inputTokens: 1, outputTokens: 1, fewShotInvoiceIds: [] }),
      finalize: async () => ({ outcome: 'saved', status: 'review', saved: true }),
      heartbeatMs: 0,
    });
    seedInvoice({ processing_stage: 'ocr' });
    seedJob();
    const r = await runProcessingTick('inv1', { deadline: clock + 20_000 });
    assert.equal(r.state, 'failed');
    assert.equal(invoice().error_message, DAMAGED_PDF_MESSAGE);
    assert.equal(loads, 0);
  });
});

describe('due jobs report what becomes due soon (#6)', () => {
  test('a job in a 5 s backoff is soon, with the wait until it is due', async () => {
    seedJob({ invoice_id: 'a' });
    seedJob({ invoice_id: 'b', retry_at: iso(clock + 5_000) });
    seedJob({ invoice_id: 'c', retry_at: iso(clock + DUE_SOON_MS + 3_000) });
    seedJob({ invoice_id: 'd', locked_until: iso(clock + 45_000) });
    const due = await dueJobs(5);
    assert.deepEqual(due.ids, ['a']);
    assert.equal(due.total, 1);
    assert.equal(due.soon, 1);
    assert.equal(due.nextDueInMs, 5_000);
  });

  test('nothing within the horizon -> null', async () => {
    seedJob({ invoice_id: 'd', locked_until: iso(clock + 45_000) });
    const due = await dueJobs(5);
    assert.equal(due.total, 0);
    assert.equal(due.soon, 0);
    assert.equal(due.nextDueInMs, null);
  });
});
