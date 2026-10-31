// QA round 5 queue findings: a PDF that neither pdf-lib nor Vision can read is "damaged" (#3), the
// too-many-attempts message suggests splitting only long documents (#5).
import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDb, type FakeDb } from './fakeDb';
import { runProcessingTick, setQueueDepsForTests } from '@/lib/processingQueue';
import { MAX_STAGE_ATTEMPTS, TOO_MANY_ATTEMPTS_LONG_MESSAGE, TOO_MANY_ATTEMPTS_MESSAGE } from '@/shared/processing';
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

function visionRejects(message: string) {
  setQueueDepsForTests({
    db: db.client,
    now: () => clock,
    fetchFile: async () => PDF,
    loadPdf: async () => null, // pdf-lib threw
    ocrPdfPages: async () => {
      ocrCalls++;
      throw new Error(message);
    },
    loadFewShot: async () => ({ examples: [], supplierVatId: null }),
    extract: async () => ({ data: DATA, inputTokens: 1, outputTokens: 1, fewShotInvoiceIds: [] }),
    finalize: async () => ({ outcome: 'saved', status: 'review', saved: true }),
    heartbeatMs: 0,
  });
}

describe('a PDF neither pdf-lib nor Vision can read (#3)', () => {
  test('fails at once with the damaged-file message', async () => {
    visionRejects('Google Cloud Vision error: Unsupported input file format. [3 INVALID_ARGUMENT]');
    seedInvoice({ processing_stage: 'ocr' });
    seedJob();
    const r = await runProcessingTick('inv1', { deadline: clock + 20_000 });
    assert.equal(r.state, 'failed');
    assert.equal(invoice().status, 'error');
    assert.equal(invoice().error_message, DAMAGED_PDF_MESSAGE);
    assert.equal(ocrCalls, 1);
  });

  test('a transient Vision failure is still retried, not called damaged', async () => {
    visionRejects('fetch failed: ECONNRESET');
    seedInvoice({ processing_stage: 'ocr' });
    seedJob();
    const r = await runProcessingTick('inv1', { deadline: clock + 20_000 });
    assert.notEqual(r.state, 'failed');
    assert.equal(invoice().status, 'processing');
  });
});

describe('too many interrupted attempts (#5)', () => {
  for (const [pages, expected] of [[1, TOO_MANY_ATTEMPTS_MESSAGE], [25, TOO_MANY_ATTEMPTS_LONG_MESSAGE]] as const) {
    test(`${pages} page(s)`, async () => {
      seedInvoice({ processing_stage: 'ocr' });
      seedJob({ page_count: pages, stage_attempts: MAX_STAGE_ATTEMPTS, locked_until: new Date(clock - 1_000).toISOString() });
      const r = await runProcessingTick('inv1', { deadline: clock + 20_000 });
      assert.equal(r.state, 'failed');
      assert.equal(invoice().error_message, expected);
    });
  }
});

describe('a PDF pdf-lib loads but whose objects are broken (#3)', () => {
  // The real ocrPdfPages: copying the pages throws a pdf-lib error before any Vision call.
  async function brokenDoc() {
    const { PDFDocument } = await import('pdf-lib');
    const doc = await PDFDocument.create();
    doc.addPage();
    doc.getPages = () => {
      throw new Error('Expected instance of PDFDict, but got instance of undefined');
    };
    return doc;
  }

  test('ocrPdfPages throws the permanent damaged-file error', async () => {
    const { ocrPdfPages } = await import('@/agents/preprocessor');
    const { UserFacingError } = await import('@/shared/processing');
    process.env.GOOGLE_CLOUD_API_KEY ??= 'test-key';
    await assert.rejects(ocrPdfPages(PDF, await brokenDoc(), [1]), (err: unknown) => {
      assert.ok(err instanceof UserFacingError);
      assert.equal((err as Error).message, DAMAGED_PDF_MESSAGE);
      return true;
    });
  });

  test('the run fails at once with the damaged-file message', async () => {
    const { ocrPdfPages } = await import('@/agents/preprocessor');
    process.env.GOOGLE_CLOUD_API_KEY ??= 'test-key';
    const doc = await brokenDoc();
    setQueueDepsForTests({
      db: db.client,
      now: () => clock,
      fetchFile: async () => PDF,
      loadPdf: async () => doc,
      ocrPdfPages: (file, pdf, pages, options) => ocrPdfPages(file, pdf as Parameters<typeof ocrPdfPages>[1], pages, options),
      loadFewShot: async () => ({ examples: [], supplierVatId: null }),
      extract: async () => ({ data: DATA, inputTokens: 1, outputTokens: 1, fewShotInvoiceIds: [] }),
      finalize: async () => ({ outcome: 'saved', status: 'review', saved: true }),
      heartbeatMs: 0,
    });
    seedInvoice({ processing_stage: 'ocr' });
    seedJob();
    const r = await runProcessingTick('inv1', { deadline: clock + 20_000 });
    assert.equal(r.state, 'failed');
    assert.equal(invoice().status, 'error');
    assert.equal(invoice().error_message, DAMAGED_PDF_MESSAGE);
  });
});
