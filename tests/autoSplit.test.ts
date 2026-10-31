// Automatic split of multi-document PDFs in the processing queue (QA: QA-split-3docs.pdf and a
// 22-page scan came out as ONE review row; auto-split was off since 2026-10-30), plus the live
// review warnings and the remembered review-list filter.
import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDb, type FakeDb } from './fakeDb';
import {
  MIN_SPLIT_STEP_MS,
  autoSplitPartId,
  autoSplitSettings,
  minStepMs,
  runProcessingTick,
  setQueueDepsForTests,
  type QueueDeps,
} from '@/lib/processingQueue';
import type { BoundaryDetectionResult } from '@/agents/splitter';
import { buildSplitSuggestion, type PageRange, type SplitSuggestion } from '@/shared/documentSplit';
import type { ExtractedData } from '@/shared/types';
import { CREDIT_NOTE_WARNING, MISSING_DATE_WARNING, lineItemsSumMismatch, liveReviewWarnings } from '@/shared/reviewWarnings';
import { LINE_ITEMS_WARNING_PREFIX } from '@/shared/lineItems';
import { initialListFilters, reviewListHref } from '@/components/InvoiceTable/listFilters';

const T0 = Date.parse('2026-10-31T10:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const DATA = { supplier_name: 'ספק', total_amount: 117, vat_amount: 17, amount_before_vat: 100 } as unknown as ExtractedData;
const PAGES = ['חשבונית 1 עמוד', 'חשבונית 2 עמוד א', 'חשבונית 2 עמוד ב', 'חשבונית 3'];

let db: FakeDb;
let clock: number;
let detectCalls: number;
let splitCalls: PageRange[][];
let detection: BoundaryDetectionResult;
let splitError: Error | null;

function suggestion(ranges: [number, number][], confidence: number, pageCount = PAGES.length): SplitSuggestion {
  return buildSplitSuggestion(ranges.map(([s, e]) => ({ start_page: s, end_page: e })), confidence, 'llm', pageCount, new Date(T0));
}

function seed(jobOver: Record<string, unknown> = {}) {
  db.tables.invoices = [{
    id: 'inv1', client_id: 'c1', file_url: 'c1/scan.pdf', file_name: 'scan.pdf', file_hash: 'srchash',
    status: 'processing', processing_run_id: 'run1', processing_started_at: iso(T0), processing_attempts: 1,
    processing_stage: 'detect', processing_progress: null, error_message: null, updated_at: iso(T0), created_at: iso(T0),
  }];
  db.tables.processing_jobs = [{
    invoice_id: 'inv1', run_id: 'run1', client_id: 'c1', file_url: 'c1/scan.pdf', mime_type: 'application/pdf',
    stage: 'detect', page_count: PAGES.length, pages_done: PAGES.length, page_texts: PAGES,
    ocr_words: PAGES.map((_, i) => ({ text: `w${i + 1}`, bbox: { x1: 0, y1: 0, x2: 1, y2: 1 }, page: i + 1 })),
    ocr_confidence: 0.9, detected_languages: ['he'], ocr_op_count: 2, split_suggestion: null,
    split_detection_failed: false, split_input_tokens: 0, split_output_tokens: 0, extract_state: null,
    stage_attempts: 0, transient_attempts: 0, retry_at: null, lock_version: 0, locked_until: null, last_error: null,
    updated_at: iso(T0), ...jobOver,
  }];
}

function useDeps(over: Partial<QueueDeps> = {}) {
  setQueueDepsForTests({
    db: db.client,
    now: () => clock,
    fetchFile: async () => Buffer.from('%PDF-1.4'),
    loadPdf: async () => ({ getPageCount: () => PAGES.length }),
    ocrPdfPages: async () => { throw new Error('no OCR expected'); },
    detect: async () => { detectCalls++; return detection; },
    loadFewShot: async () => ({ examples: [], supplierVatId: null }),
    extract: async () => ({ data: DATA, inputTokens: 1, outputTokens: 1, fewShotInvoiceIds: [] }),
    finalize: async () => ({ outcome: 'saved', status: 'review', saved: true }),
    splitPdf: async (_file, ranges) => {
      splitCalls.push(ranges);
      if (splitError) throw splitError;
      return ranges.map((r, i) => ({ ...r, fileUrl: `c1/auto_part_${i + 1}.pdf` }));
    },
    autoSplit: { enabled: true, minConfidence: 0.9 },
    heartbeatMs: 0,
    ...over,
  });
}

const invoices = () => db.tables.invoices as Record<string, any>[];
const jobs = () => db.tables.processing_jobs as Record<string, any>[];
const jobOf = (id: string) => jobs().find((j) => j.invoice_id === id);

beforeEach(() => {
  db = createFakeDb();
  clock = T0 + 1_000;
  detectCalls = 0;
  splitCalls = [];
  splitError = null;
  detection = { suggestion: suggestion([[1, 1], [2, 3], [4, 4]], 0.98), inputTokens: 100, outputTokens: 20 };
  useDeps();
});

afterEach(() => setQueueDepsForTests(null));

describe('automatic split in the processing queue', () => {
  test('a confident 3-document detection splits the file into 3 queued invoices', async () => {
    seed();
    const r = await runProcessingTick('inv1', { deadline: clock + 22_000 });
    assert.equal(r.state, 'pending');
    assert.equal(splitCalls.length, 1);
    assert.deepEqual(splitCalls[0], [{ start_page: 1, end_page: 1 }, { start_page: 2, end_page: 3 }, { start_page: 4, end_page: 4 }]);
    assert.equal(invoices().length, 3);
    assert.deepEqual(invoices().map((i) => i.file_name).sort(), ['scan_חלק_1.pdf', 'scan_חלק_2.pdf', 'scan_חלק_3.pdf']);
    const parent = invoices().find((i) => i.id === 'inv1')!;
    assert.equal(parent.file_url, 'c1/auto_part_1.pdf');
    assert.equal(parent.status, 'processing');
    assert.notEqual(parent.processing_run_id, 'run1');
    assert.equal(parent.original_file_url, 'c1/scan.pdf');
    for (const part of invoices().filter((i) => i.id !== 'inv1')) {
      assert.equal(part.split_parent_id, 'inv1');
      assert.equal(part.status, 'processing');
      assert.ok(part.processing_run_id);
    }
    // Every part has its own job, starting at extraction with its own pages' OCR
    assert.equal(jobs().length, 3);
    const p2 = jobOf(autoSplitPartId('run1', 2))!;
    assert.equal(p2.stage, 'extract');
    assert.deepEqual(p2.page_texts, ['חשבונית 2 עמוד א', 'חשבונית 2 עמוד ב']);
    assert.deepEqual(p2.ocr_words.map((w: any) => w.page), [1, 2]);
    assert.equal(p2.ocr_op_count, 0);
    const p1 = jobOf('inv1')!;
    assert.equal(p1.run_id, parent.processing_run_id);
    assert.equal(p1.ocr_op_count, 2);
    assert.equal(p1.split_input_tokens, 100);
    assert.deepEqual(r.splitInto?.length, 3);
  });

  test('a part goes on to extraction and review on its own', async () => {
    seed();
    await runProcessingTick('inv1', { deadline: clock + 22_000 });
    const id = autoSplitPartId('run1', 3);
    const r = await runProcessingTick(id, { deadline: clock + 22_000 });
    assert.equal(r.state, 'done');
    assert.equal(detectCalls, 1);
  });

  test('below the threshold the file stays whole and the split is only suggested', async () => {
    detection = { suggestion: suggestion([[1, 1], [2, 3], [4, 4]], 0.7), inputTokens: 1, outputTokens: 1 };
    seed();
    const r = await runProcessingTick('inv1', { deadline: clock + 22_000 });
    assert.equal(r.stage, 'extract');
    assert.equal(splitCalls.length, 0);
    assert.equal(invoices().length, 1);
    assert.equal(jobOf('inv1')!.stage, 'extract');
    assert.equal(jobOf('inv1')!.split_suggestion.confidence, 0.7);
  });

  test('a single document is never split', async () => {
    detection = { suggestion: null, inputTokens: 1, outputTokens: 1 };
    seed();
    await runProcessingTick('inv1', { deadline: clock + 22_000 });
    assert.equal(splitCalls.length, 0);
    assert.equal(invoices().length, 1);
  });

  test('switched off by settings: suggestion only', async () => {
    useDeps({ autoSplit: { enabled: false, minConfidence: 0.9 } });
    seed();
    await runProcessingTick('inv1', { deadline: clock + 22_000 });
    assert.equal(splitCalls.length, 0);
    assert.equal(jobOf('inv1')!.stage, 'extract');
  });

  test('without time left after detection, the next tick splits without detecting again', async () => {
    seed();
    useDeps({ detect: async () => { detectCalls++; clock += 15_000; return detection; } });
    const r = await runProcessingTick('inv1', { deadline: clock + 22_000 });
    assert.equal(r.stage, 'splitting');
    assert.equal(splitCalls.length, 0);
    assert.equal(jobOf('inv1')!.stage, 'detect');
    assert.ok(jobOf('inv1')!.split_suggestion);
    assert.equal(minStepMs(jobOf('inv1') as any), MIN_SPLIT_STEP_MS);
    clock += 1_000;
    await runProcessingTick('inv1', { deadline: clock + 22_000 });
    assert.equal(detectCalls, 1);
    assert.equal(splitCalls.length, 1);
    assert.equal(invoices().length, 3);
  });

  test('a retried split step does not create the parts twice', async () => {
    seed({ split_suggestion: detection.suggestion });
    const originalJob = structuredClone(jobs()[0]);
    await runProcessingTick('inv1', { deadline: clock + 22_000 });
    assert.equal(invoices().length, 3);
    // As if the tick had been killed after the rows were written but before any enqueue
    const parent = invoices().find((i) => i.id === 'inv1')!;
    parent.processing_run_id = 'run1';
    for (const part of invoices().filter((i) => i.id !== 'inv1')) part.processing_run_id = null;
    db.tables.processing_jobs = [{ ...originalJob, lock_version: 5 }];
    clock += 1_000;
    await runProcessingTick('inv1', { deadline: clock + 22_000 });
    assert.equal(splitCalls.length, 2);
    assert.equal(invoices().length, 3);
    assert.equal(jobs().length, 3);
    assert.ok(invoices().every((i) => i.processing_run_id));
  });

  test('a file that cannot be split is extracted whole with the suggestion', async () => {
    splitError = new Error('Failed to parse PDF document');
    seed();
    const r = await runProcessingTick('inv1', { deadline: clock + 22_000 });
    assert.equal(r.stage, 'extract');
    assert.equal(invoices().length, 1);
    assert.equal(invoices()[0].file_name, 'scan.pdf');
    assert.equal(jobOf('inv1')!.stage, 'extract');
  });

  test('part ids are stable per run and look like UUIDs', () => {
    assert.equal(autoSplitPartId('run1', 2), autoSplitPartId('run1', 2));
    assert.notEqual(autoSplitPartId('run1', 2), autoSplitPartId('run1', 3));
    assert.match(autoSplitPartId('run1', 2), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test('settings from the environment', () => {
    assert.deepEqual(autoSplitSettings({}), { enabled: true, minConfidence: 0.9 });
    assert.equal(autoSplitSettings({ AUTO_SPLIT_ENABLED: 'false' }).enabled, false);
    assert.equal(autoSplitSettings({ AUTO_SPLIT_ENABLED: '0' }).enabled, false);
    assert.equal(autoSplitSettings({ AUTO_SPLIT_MIN_CONFIDENCE: '0.95' }).minConfidence, 0.95);
    assert.equal(autoSplitSettings({ AUTO_SPLIT_MIN_CONFIDENCE: '85' }).minConfidence, 0.85);
    assert.equal(autoSplitSettings({ AUTO_SPLIT_MIN_CONFIDENCE: '0.2' }).minConfidence, 0.9);
    assert.equal(autoSplitSettings({ AUTO_SPLIT_MIN_CONFIDENCE: 'abc' }).minConfidence, 0.9);
  });
});

describe('live review warnings', () => {
  const amounts = { amount_before_vat: 100, vat_amount: 18, total_amount: 118 };

  test('the missing-date warning goes away once a date is entered', () => {
    assert.deepEqual(liveReviewWarnings([MISSING_DATE_WARNING], { ...amounts, invoice_date: null }), [MISSING_DATE_WARNING]);
    assert.deepEqual(liveReviewWarnings([MISSING_DATE_WARNING], { ...amounts, invoice_date: '2026-06-03' }), []);
  });

  test('the credit-note warning follows the total', () => {
    assert.deepEqual(liveReviewWarnings([CREDIT_NOTE_WARNING], { ...amounts, total_amount: -50, amount_before_vat: -50, vat_amount: 0, invoice_date: '2026-06-03' }).includes(CREDIT_NOTE_WARNING), true);
    assert.deepEqual(liveReviewWarnings([CREDIT_NOTE_WARNING], { ...amounts, invoice_date: '2026-06-03' }), []);
  });

  test('line-item mismatch shows while editing, before approval', () => {
    const data = { ...amounts, invoice_date: '2026-06-03', line_items: [{ description: 'x', quantity: 1, unit_price: 450, line_total: 450 }] as any };
    const w = liveReviewWarnings([], data);
    assert.equal(w.filter((x) => x.startsWith(LINE_ITEMS_WARNING_PREFIX)).length, 1);
    assert.match(w[0], /450/);
    assert.equal(lineItemsSumMismatch(data), true);
    const fixed = { ...data, line_items: [{ description: 'x', quantity: 1, unit_price: 100, line_total: 100 }] };
    assert.deepEqual(liveReviewWarnings(w, fixed), []);
    assert.equal(lineItemsSumMismatch(fixed), false);
  });

  test('other stored warnings are kept', () => {
    assert.deepEqual(liveReviewWarnings(['אחר'], { ...amounts, invoice_date: '2026-06-03' }), ['אחר']);
  });
});

describe('review list filter', () => {
  test('URL wins, then the stored filter, then all', () => {
    assert.deepEqual(initialListFilters('?client=c1', JSON.stringify({ client: 'c2', status: 'review' })), { client: 'c1', status: 'review' });
    assert.deepEqual(initialListFilters('', JSON.stringify({ client: 'c2', status: 'all' })), { client: 'c2', status: 'all' });
    assert.deepEqual(initialListFilters('', null), { client: 'all', status: 'all' });
    assert.deepEqual(initialListFilters('', '{bad json'), { client: 'all', status: 'all' });
  });

  test('back-to-list link keeps the client', () => {
    assert.equal(reviewListHref('abc'), '/review?client=abc');
    assert.equal(reviewListHref(null), '/review');
  });
});
