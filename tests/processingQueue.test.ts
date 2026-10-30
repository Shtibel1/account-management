import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDb, type FakeDb } from './fakeDb';
import {
  runProcessingTick,
  setQueueDepsForTests,
  sweepStaleProcessing,
  dueJobs,
  type ExtractCallInput,
  type ExtractCallResult,
} from '@/lib/processingQueue';
import {
  CONNECTION_ERROR_MESSAGE,
  ENQUEUE_GRACE_MS,
  INTERRUPTED_STEP_ERROR,
  LLM_FULL_WINDOW_MS,
  MAX_STAGE_ATTEMPTS,
  MAX_TRANSIENT_ATTEMPTS,
  MIN_LLM_STEP_MS,
  OPTIONAL_STEP_TRANSIENT_RETRIES,
  STALE_PROCESSING_MS,
  STUCK_RUN_MESSAGE,
  transientBackoffMs,
} from '@/shared/processing';
import type { ExtractedData } from '@/shared/types';

const T0 = Date.parse('2026-10-30T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

let db: FakeDb;
let clock: number;
let extract: (input: ExtractCallInput) => Promise<ExtractCallResult>;
let extractCalls: ExtractCallInput[];

const DATA = { supplier_name: 'ספק', total_amount: 117, vat_amount: 17, amount_before_vat: 100 } as unknown as ExtractedData;

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
    processing_stage: 'extract',
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
    stage: 'extract',
    page_count: 2,
    pages_done: 2,
    page_texts: ['עמוד ראשון', 'עמוד שני'],
    ocr_words: [],
    ocr_confidence: 0.9,
    detected_languages: ['he'],
    ocr_op_count: 1,
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

const job = () => db.tables.processing_jobs?.find((j) => j.invoice_id === 'inv1') as Record<string, unknown> | undefined;
const invoice = (id = 'inv1') => db.tables.invoices.find((i) => i.id === id) as Record<string, unknown>;

beforeEach(() => {
  db = createFakeDb();
  clock = T0 + 1_000;
  extractCalls = [];
  extract = async () => ({ data: DATA, inputTokens: 10, outputTokens: 5, fewShotInvoiceIds: [] });
  setQueueDepsForTests({
    db: db.client,
    now: () => clock,
    fetchFile: async () => Buffer.from('%PDF-1.4 test'),
    loadFewShot: async () => ({ examples: [], supplierVatId: null }),
    extract: (input) => {
      extractCalls.push(input);
      return extract(input);
    },
    finalize: async () => ({ outcome: 'saved', status: 'review', saved: true }),
    heartbeatMs: 0,
  });
});

afterEach(() => setQueueDepsForTests(null));

describe('transient vs real step failures', () => {
  test('a dropped connection backs off without using a real attempt', async () => {
    seedInvoice();
    seedJob();
    extract = async () => {
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) });
    };
    const r = await runProcessingTick('inv1', { deadline: clock + 20_000 });
    assert.equal(r.state, 'busy');
    assert.equal(job()?.stage_attempts, 0);
    assert.equal(job()?.transient_attempts, 1);
    assert.equal(job()?.locked_until, null);
    assert.equal(job()?.retry_at, iso(clock + transientBackoffMs(1)));
    assert.match(String(job()?.last_error), /fetch failed/);

    // Before the backoff ends nobody takes the job
    clock += 1_000;
    const early = await runProcessingTick('inv1', { deadline: clock + 20_000 });
    assert.equal(early.state, 'busy');
    assert.equal(extractCalls.length, 1);
  });

  test('transient failures fail the run only after MAX_TRANSIENT_ATTEMPTS, with a Hebrew connection message and the cause kept', async () => {
    seedInvoice();
    seedJob();
    extract = async () => {
      throw Object.assign(new Error('Connection error.'), { name: 'APIConnectionError' });
    };
    let last;
    for (let i = 0; i < MAX_TRANSIENT_ATTEMPTS; i++) {
      clock += 5 * 60_000; // past any backoff
      last = await runProcessingTick('inv1', { deadline: clock + 20_000 });
      if (i < MAX_TRANSIENT_ATTEMPTS - 1) assert.equal(last.state, 'busy', `attempt ${i + 1}`);
    }
    assert.equal(last?.state, 'failed');
    assert.equal(extractCalls.length, MAX_TRANSIENT_ATTEMPTS);
    assert.equal(invoice().status, 'error');
    assert.equal(invoice().error_message, CONNECTION_ERROR_MESSAGE);
    assert.match(String(invoice().processing_error_detail), /Connection error/);
    assert.match(String(invoice().processing_error_detail), /transient 6\/6/);
    assert.equal(job(), undefined);
  });

  test('real errors keep the MAX_STAGE_ATTEMPTS budget', async () => {
    seedInvoice();
    seedJob();
    extract = async () => {
      throw new Error('Unexpected tool input');
    };
    for (let i = 1; i < MAX_STAGE_ATTEMPTS; i++) {
      const r = await runProcessingTick('inv1', { deadline: clock + 20_000 });
      assert.equal(r.state, 'pending');
      assert.equal(job()?.stage_attempts, i);
      assert.equal(job()?.transient_attempts, 0);
    }
    const r = await runProcessingTick('inv1', { deadline: clock + 20_000 });
    assert.equal(r.state, 'failed');
    assert.equal(invoice().status, 'error');
    assert.match(String(invoice().processing_error_detail), /Unexpected tool input/);
  });

  test('a lease that ran out (interrupted tick) is re-claimed as a transient failure', async () => {
    seedInvoice();
    seedJob({ locked_until: iso(clock - 1_000), lock_version: 3, stage_attempts: 2 });
    const r = await runProcessingTick('inv1', { deadline: clock + 20_000 });
    // The step itself then succeeds and finishes the run
    assert.equal(r.state, 'done');
    assert.equal(extractCalls.length, 1);
  });

  test('an interrupted re-claim counts transient_attempts, not stage_attempts', async () => {
    seedInvoice();
    seedJob({ locked_until: iso(clock - 1_000), lock_version: 3, stage_attempts: 2 });
    extract = async () => {
      throw new Error('still broken');
    };
    await runProcessingTick('inv1', { deadline: clock + 20_000 });
    // interruption -> transient 1; the real error of this tick -> stage 3 = MAX -> failed
    assert.equal(invoice().status, 'error');
    assert.match(String(invoice().processing_error_detail), /transient 1\//);
  });

  test('an interrupted re-claim records the interruption as the last error', async () => {
    seedInvoice();
    seedJob({ locked_until: iso(clock - 1_000), lock_version: 3 });
    extract = async () => new Promise(() => {}); // never ends: inspect the claim
    void runProcessingTick('inv1', { deadline: clock + 20_000 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(job()?.transient_attempts, 1);
    assert.equal(job()?.stage_attempts, 0);
    assert.equal(job()?.last_error, INTERRUPTED_STEP_ERROR);
    assert.equal(job()?.lock_version, 4);
  });
});

describe('deadline', () => {
  test('a step that does not fit before the deadline is not started', async () => {
    seedInvoice();
    seedJob();
    const r = await runProcessingTick('inv1', { deadline: clock + MIN_LLM_STEP_MS - 1 });
    assert.equal(r.state, 'pending');
    assert.equal(r.deferred, true);
    assert.equal(job()?.lock_version, 0);
    assert.equal(extractCalls.length, 0);
  });

  test('LLM calls get a timeout that ends before the deadline', async () => {
    seedInvoice();
    seedJob();
    await runProcessingTick('inv1', { deadline: clock + 19_000 });
    assert.equal(extractCalls.length, 1);
    assert.ok(extractCalls[0].timeoutMs >= LLM_FULL_WINDOW_MS, `timeout ${extractCalls[0].timeoutMs}`);
    assert.ok(extractCalls[0].timeoutMs <= 19_000 - 2_000, `timeout ${extractCalls[0].timeoutMs}`);
    assert.equal(extractCalls[0].allowLargeRetry, false);
  });

  test('a multi-page part that times out is split in two instead of failing', async () => {
    seedInvoice();
    seedJob();
    extract = async () => {
      throw Object.assign(new Error('Request timed out.'), { name: 'APIConnectionTimeoutError' });
    };
    const r = await runProcessingTick('inv1', { deadline: clock + 20_000 });
    assert.equal(r.state, 'pending');
    const state = job()?.extract_state as { chunks: { start: number; end: number }[] };
    assert.deepEqual(state.chunks, [{ start: 1, end: 1 }, { start: 2, end: 2 }]);
    assert.equal(job()?.stage_attempts, 0);
    assert.equal(job()?.transient_attempts, 0);
  });
});

describe('rows without a job', () => {
  test('a never-queued processing row is queued, not failed', async () => {
    seedInvoice({ processing_run_id: null, processing_started_at: null, processing_attempts: 0, processing_stage: null, updated_at: iso(T0 - 2 * 60 * 60_000) });
    const r = await runProcessingTick('inv1', { deadline: clock + 20_000 });
    assert.equal(r.state, 'pending');
    assert.equal(invoice().processing_attempts, 1);
    assert.equal(invoice().processing_started_at, iso(clock));
    assert.equal(job()?.run_id, invoice().processing_run_id);
  });

  test('a fresh never-queued row waits for its own enqueue (grace)', async () => {
    seedInvoice({ processing_run_id: null, processing_started_at: null, processing_attempts: 0, processing_stage: null, updated_at: iso(clock - 5_000) });
    const r = await runProcessingTick('inv1', { deadline: clock + 20_000 });
    assert.equal(r.state, 'waiting');
    assert.equal(job(), undefined);
  });

  test('a queued run whose job is gone fails as stuck once stale', async () => {
    seedInvoice({ updated_at: iso(T0) });
    clock = T0 + STALE_PROCESSING_MS + 1_000;
    const r = await runProcessingTick('inv1', { deadline: clock + 20_000 });
    assert.equal(r.state, 'failed');
    assert.equal(invoice().error_message, STUCK_RUN_MESSAGE);
    assert.match(String(invoice().processing_error_detail), /no job of run run1/);
  });

  test('the sweep queues never-queued rows and fails only stale queued ones', async () => {
    const old = iso(T0 - 2 * 60 * 60_000);
    seedInvoice({ id: 'legacy', processing_run_id: null, processing_started_at: null, processing_attempts: 0, processing_stage: null, updated_at: old });
    seedInvoice({ id: 'lost', processing_attempts: 1, processing_started_at: old, updated_at: old });
    seedInvoice({ id: 'young', processing_run_id: null, processing_started_at: null, processing_attempts: 0, processing_stage: null, updated_at: iso(clock - ENQUEUE_GRACE_MS / 2) });
    seedInvoice({ id: 'queued', processing_run_id: 'r-q', updated_at: old });
    seedJob({ invoice_id: 'queued', run_id: 'r-q', updated_at: old });

    const result = await sweepStaleProcessing(null);
    assert.deepEqual(result.enqueued, ['legacy']);
    assert.deepEqual(result.failed, ['lost']);
    assert.equal(invoice('legacy').status, 'processing');
    assert.equal(invoice('lost').status, 'error');
    assert.equal(invoice('young').processing_attempts, 0);
    assert.equal(invoice('queued').status, 'processing');
  });
});

/** Test deps with a few overrides (the rest as in beforeEach). */
function useDeps(over: Partial<Parameters<typeof setQueueDepsForTests>[0] & object>) {
  setQueueDepsForTests({
    db: db.client,
    now: () => clock,
    fetchFile: async () => Buffer.from('%PDF-1.4 test'),
    loadFewShot: async () => ({ examples: [], supplierVatId: null }),
    extract: (input) => {
      extractCalls.push(input);
      return extract(input);
    },
    finalize: async () => ({ outcome: 'saved', status: 'review', saved: true }),
    heartbeatMs: 0,
    ...over,
  });
}

const cutAtLimit = (): ExtractCallResult => ({
  data: { supplier_name: 'חלקי' } as unknown as ExtractedData,
  inputTokens: 10,
  outputTokens: 900,
  fewShotInvoiceIds: [],
  truncated: true,
  timedOut: true,
});

describe('time-limited extraction calls (QA round 3 review)', () => {
  test('a call that only had a short window (started late) is retried, not split', async () => {
    seedInvoice();
    seedJob();
    extract = async () => {
      throw Object.assign(new Error('Request timed out.'), { name: 'APIConnectionTimeoutError' });
    };
    // a slow few-shot lookup eats the window
    useDeps({
      loadFewShot: async () => {
        clock += 6_000;
        return { examples: [], supplierVatId: null };
      },
    });
    const r = await runProcessingTick('inv1', { deadline: clock + 20_000 });
    assert.ok(extractCalls[0].timeoutMs < LLM_FULL_WINDOW_MS);
    assert.equal(r.state, 'busy');
    assert.equal(job()?.transient_attempts, 1);
    const state = job()?.extract_state as { chunks: unknown[] } | null;
    assert.ok(!state || state.chunks.length === 1, 'not split');
  });

  test('a multi-page part cut at the time limit with a full window is split, its tokens kept', async () => {
    seedInvoice();
    seedJob();
    extract = async () => cutAtLimit();
    const r = await runProcessingTick('inv1', { deadline: clock + 23_000 });
    assert.equal(r.state, 'pending');
    const state = job()?.extract_state as { chunks: unknown[]; discarded_tokens: { input: number; output: number } };
    assert.equal(state.chunks.length, 2);
    assert.deepEqual(state.discarded_tokens, { input: 10, output: 900 });
  });

  test('a one-page part cut at the time limit is tried once more, then keeps its partial result', async () => {
    seedInvoice();
    seedJob({ page_count: 1, pages_done: 1, page_texts: ['עמוד יחיד'] });
    const saved: ExtractedData[] = [];
    extract = async () => cutAtLimit();
    useDeps({
      finalize: async (input) => {
        saved.push(input.extractedData);
        return { outcome: 'saved', status: 'review', saved: true };
      },
    });
    const first = await runProcessingTick('inv1', { deadline: clock + 23_000 });
    assert.equal(first.state, 'busy');
    assert.equal(job()?.transient_attempts, 1);
    clock += 60_000;
    const second = await runProcessingTick('inv1', { deadline: clock + 23_000 });
    assert.equal(second.state, 'done');
    assert.equal(extractCalls.length, 2);
    assert.equal(saved[0]?.supplier_name, 'חלקי');
  });
});

describe('optional steps (QA round 3 review)', () => {
  /** A one-page job whose first validation asks for the math re-read; finalize records what it got. */
  function retrySetup(retryCall: () => Promise<ExtractCallResult>) {
    seedInvoice();
    seedJob({ page_count: 1, pages_done: 1, page_texts: ['עמוד יחיד'] });
    const finals: { data: ExtractedData; retryCount: number }[] = [];
    extract = async () => (extractCalls.length === 1 ? { data: DATA, inputTokens: 10, outputTokens: 5, fewShotInvoiceIds: [] } : retryCall());
    useDeps({
      finalize: async (input) => {
        finals.push({ data: input.extractedData, retryCount: input.retryCount });
        return finals.length === 1 ? { outcome: 'retry' } : { outcome: 'saved', status: 'review', saved: true };
      },
    });
    return finals;
  }

  test('a re-read cut at its limit keeps the complete first-pass result', async () => {
    const finals = retrySetup(async () => cutAtLimit());
    assert.equal((await runProcessingTick('inv1', { deadline: clock + 23_000 })).state, 'pending');
    assert.equal((await runProcessingTick('inv1', { deadline: clock + 23_000 })).state, 'done');
    assert.equal(finals.length, 2);
    assert.equal(finals[1].retryCount, 1);
    assert.equal(finals[1].data.total_amount, 117);
  });

  test('a re-read that keeps failing transiently saves the first-pass result instead of failing the run', async () => {
    const finals = retrySetup(async () => {
      throw Object.assign(new Error('Connection error.'), { name: 'APIConnectionError' });
    });
    await runProcessingTick('inv1', { deadline: clock + 23_000 });
    let last;
    for (let i = 0; i <= OPTIONAL_STEP_TRANSIENT_RETRIES; i++) {
      clock += 5 * 60_000;
      last = await runProcessingTick('inv1', { deadline: clock + 23_000 });
    }
    assert.equal(last?.state, 'done');
    assert.equal(extractCalls.length, 1 + OPTIONAL_STEP_TRANSIENT_RETRIES + 1);
    assert.equal(finals[1].data.total_amount, 117);
    assert.notEqual(invoice().status, 'error');
  });

  test('a real error of the re-read saves the first-pass result at once', async () => {
    const finals = retrySetup(async () => {
      throw new Error('Unexpected tool input');
    });
    await runProcessingTick('inv1', { deadline: clock + 23_000 });
    const r = await runProcessingTick('inv1', { deadline: clock + 23_000 });
    assert.equal(r.state, 'done');
    assert.equal(finals.length, 2);
    assert.equal(finals[1].retryCount, 1);
  });

  test('boundary detection is retried on transient failures, then the run goes on without a suggestion', async () => {
    seedInvoice();
    seedJob({ stage: 'detect' });
    let detectCalls = 0;
    useDeps({
      detect: async () => {
        detectCalls++;
        throw Object.assign(new Error('Request timed out.'), { name: 'APIConnectionTimeoutError' });
      },
    });
    for (let i = 0; i < OPTIONAL_STEP_TRANSIENT_RETRIES; i++) {
      clock += 5 * 60_000;
      assert.equal((await runProcessingTick('inv1', { deadline: clock + 23_000 })).state, 'busy');
      assert.equal(job()?.stage, 'detect');
    }
    clock += 5 * 60_000;
    const r = await runProcessingTick('inv1', { deadline: clock + 23_000 });
    assert.equal(r.state, 'pending');
    assert.equal(detectCalls, OPTIONAL_STEP_TRANSIENT_RETRIES + 1);
    assert.equal(job()?.stage, 'extract');
    assert.equal(job()?.split_detection_failed, true);
  });
});

describe('sweep selection (QA round 3 review)', () => {
  test('a never-queued row is found behind many older rows with live jobs', async () => {
    const old = iso(T0 - 2 * 60 * 60_000);
    for (let i = 0; i < 120; i++) {
      seedInvoice({ id: `q${i}`, processing_run_id: `r${i}`, updated_at: old });
      seedJob({ invoice_id: `q${i}`, run_id: `r${i}`, updated_at: old });
    }
    seedInvoice({ id: 'legacy', processing_run_id: null, processing_started_at: null, processing_attempts: 0, processing_stage: null, updated_at: iso(clock - 2 * ENQUEUE_GRACE_MS) });
    const result = await sweepStaleProcessing(null);
    assert.deepEqual(result.enqueued, ['legacy']);
    assert.deepEqual(result.failed, []);
  });
});

describe('due jobs', () => {
  test('leased jobs and jobs in retry backoff are not due', async () => {
    seedJob({ invoice_id: 'a', updated_at: iso(T0 - 3_000) });
    seedJob({ invoice_id: 'b', locked_until: iso(clock + 10_000), updated_at: iso(T0 - 2_000) });
    seedJob({ invoice_id: 'c', retry_at: iso(clock + 10_000), updated_at: iso(T0 - 1_000) });
    seedJob({ invoice_id: 'd', retry_at: iso(clock - 10_000), updated_at: iso(T0) });
    const due = await dueJobs(1);
    assert.deepEqual(due.ids, ['a']);
    assert.equal(due.total, 2);
  });
});
