import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONNECTION_ERROR_MESSAGE,
  ENQUEUE_GRACE_MS,
  INTERRUPTED_STEP_ERROR,
  STALE_PROCESSING_MS,
  STUCK_RUN_MESSAGE,
  TRANSIENT_EXHAUSTED_MESSAGE,
  UserFacingError,
  errorDetail,
  isConnectionError,
  isStaleRun,
  isTimeoutError,
  isTransientError,
  orphanRunAction,
  toUserErrorMessage,
  transientBackoffMs,
  transientFailureMessage,
} from '@/shared/processing';
import { initialExtractState, splitChunk, extractionTokens } from '@/shared/extractionChunks';

const named = (name: string, message: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(message), { name }, extra);

describe('isTransientError', () => {
  test('network drops and interruptions are transient', () => {
    assert.equal(isTransientError(new TypeError('fetch failed', { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) })), true);
    assert.equal(isTransientError(named('APIConnectionError', 'Connection error.')), true);
    assert.equal(isTransientError(new Error('Connection error.')), true);
    assert.equal(isTransientError(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })), true);
    assert.equal(isTransientError(new Error('socket hang up')), true);
    assert.equal(isTransientError(named('APIConnectionTimeoutError', 'Request timed out.')), true);
    assert.equal(isTransientError(named('TimeoutError', 'The operation was aborted due to timeout')), true);
    assert.equal(isTransientError(new Error('processing_jobs update failed: TypeError: fetch failed')), true);
    assert.equal(isTransientError(INTERRUPTED_STEP_ERROR), true);
  });

  test('429 / 5xx of Anthropic and Google are transient, other 4xx are not', () => {
    assert.equal(isTransientError(named('RateLimitError', '429 rate_limit_error', { status: 429 })), true);
    assert.equal(isTransientError(named('InternalServerError', '529 overloaded_error', { status: 529 })), true);
    assert.equal(isTransientError(Object.assign(new Error('Google Cloud Vision page range OCR request failed: Service Unavailable.'), { status: 503 })), true);
    assert.equal(isTransientError(new Error('Google Cloud Vision page range OCR request failed: Too Many Requests.')), true);
    assert.equal(isTransientError(named('BadRequestError', '400 invalid_request_error', { status: 400 })), false);
    assert.equal(isTransientError(Object.assign(new Error('Forbidden'), { status: 403 })), false);
  });

  test('document and configuration errors are not transient', () => {
    assert.equal(isTransientError(new UserFacingError('קובץ ה-PDF אינו מכיל עמודים')), false);
    assert.equal(isTransientError(new Error('Bad Request: no pdf header')), false);
    assert.equal(isTransientError(new Error('Google Cloud Vision API key is not configured. Please set GOOGLE_CLOUD_API_KEY.')), false);
    assert.equal(isTransientError(new Error('המודל לא החזיר נתוני חשבונית')), false);
    assert.equal(isTransientError(new Error('Unexpected token in JSON')), false);
  });

  test('timeouts and connection errors are told apart', () => {
    assert.equal(isTimeoutError(named('APIConnectionTimeoutError', 'Request timed out.')), true);
    assert.equal(isTimeoutError(named('TimeoutError', 'The operation was aborted due to timeout')), true);
    assert.equal(isTimeoutError(named('APIConnectionError', 'Connection error.')), false);
    assert.equal(isConnectionError(named('APIConnectionError', 'Connection error.')), true);
    assert.equal(isConnectionError(new TypeError('fetch failed')), true);
    assert.equal(isConnectionError(Object.assign(new Error('x'), { code: 'ETIMEDOUT' })), false);
  });
});

describe('failure messages', () => {
  test('connection errors get a Hebrew message of their own', () => {
    assert.equal(toUserErrorMessage(new TypeError('fetch failed')), CONNECTION_ERROR_MESSAGE);
    assert.equal(toUserErrorMessage(named('APIConnectionError', 'Connection error.')), CONNECTION_ERROR_MESSAGE);
    // last_error is stored as text
    assert.equal(toUserErrorMessage('APIConnectionError: Connection error. <- TypeError: fetch failed'), CONNECTION_ERROR_MESSAGE);
    assert.equal(toUserErrorMessage(INTERRUPTED_STEP_ERROR), STUCK_RUN_MESSAGE);
  });

  test('a run out of transient attempts never ends with the generic message', () => {
    assert.equal(transientFailureMessage(new Error('weird transient thing: 502 bad gateway')), 'שירות הניתוח החזיר שגיאה. יש לנסות שוב בעוד כמה דקות');
    assert.equal(transientFailureMessage(new Error('something odd')), TRANSIENT_EXHAUSTED_MESSAGE);
    assert.equal(transientFailureMessage(new TypeError('fetch failed')), CONNECTION_ERROR_MESSAGE);
  });

  test('errorDetail keeps the cause chain, codes and statuses', () => {
    const err = new TypeError('fetch failed', { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) });
    assert.equal(errorDetail(err), 'TypeError: fetch failed <- Error: read ECONNRESET [ECONNRESET]');
    assert.equal(errorDetail(named('RateLimitError', 'rate', { status: 429 })), 'RateLimitError: rate (status 429)');
  });

  test('backoff grows and is capped', () => {
    assert.deepEqual([1, 2, 3, 4, 5, 6, 10].map(transientBackoffMs), [5_000, 10_000, 20_000, 40_000, 80_000, 120_000, 120_000]);
  });
});

describe('stale / never-queued runs', () => {
  const now = Date.parse('2026-10-30T12:00:00Z');
  const ago = (ms: number) => new Date(now - ms).toISOString();

  test('a run queued late is not stale: the latest timestamp starts the clock', () => {
    assert.equal(isStaleRun({ now, startedAt: ago(30 * 60_000), lastActivityAt: ago(60_000), rowUpdatedAt: ago(30 * 60_000) }), false);
    assert.equal(isStaleRun({ now, startedAt: ago(30 * 60_000), lastActivityAt: null, rowUpdatedAt: ago(60_000) }), false);
    assert.equal(isStaleRun({ now, startedAt: ago(STALE_PROCESSING_MS + 1), lastActivityAt: null, rowUpdatedAt: ago(STALE_PROCESSING_MS + 1) }), true);
  });

  test('never-queued rows are queued after the grace period, whatever their age', () => {
    const base = { now, startedAt: null, processingStage: null };
    assert.equal(orphanRunAction({ ...base, attempts: 0, rowUpdatedAt: ago(ENQUEUE_GRACE_MS / 2) }), 'wait');
    assert.equal(orphanRunAction({ ...base, attempts: 0, rowUpdatedAt: ago(ENQUEUE_GRACE_MS) }), 'enqueue');
    assert.equal(orphanRunAction({ ...base, attempts: null, rowUpdatedAt: ago(30 * 24 * 60 * 60_000) }), 'enqueue');
  });

  test('queued runs without a job fail only when stale; a split in progress is never queued', () => {
    const base = { now, startedAt: null };
    assert.equal(orphanRunAction({ ...base, attempts: 1, processingStage: 'ocr', rowUpdatedAt: ago(60_000) }), 'wait');
    assert.equal(orphanRunAction({ ...base, attempts: 1, processingStage: 'ocr', rowUpdatedAt: ago(STALE_PROCESSING_MS + 1) }), 'fail');
    assert.equal(orphanRunAction({ ...base, attempts: 0, processingStage: 'splitting', rowUpdatedAt: ago(5 * 60_000) }), 'wait');
    assert.equal(orphanRunAction({ ...base, attempts: 0, processingStage: 'splitting', rowUpdatedAt: ago(STALE_PROCESSING_MS + 1) }), 'fail');
  });
});

describe('splitChunk', () => {
  test('splits a multi-page part in two and keeps the other results', () => {
    const pages = Array.from({ length: 9 }, () => 'x'.repeat(100));
    const state = initialExtractState(pages, 9, null);
    assert.deepEqual(state.chunks, [{ start: 1, end: 3 }, { start: 4, end: 6 }, { start: 7, end: 9 }]);
    const done = { ...state, results: [{ data: {} as never, input_tokens: 1, output_tokens: 1 }, null, null] };
    const split = splitChunk(done, 1)!;
    assert.deepEqual(split.chunks, [{ start: 1, end: 3 }, { start: 4, end: 4 }, { start: 5, end: 6 }, { start: 7, end: 9 }]);
    assert.equal(split.results.length, 4);
    assert.notEqual(split.results[0], null);
    assert.equal(splitChunk(split, 1), null);
  });

  test('tokens of dropped calls stay in the cost', () => {
    const state = { ...initialExtractState(['a'], 1, null), discarded_tokens: { input: 7, output: 3 } };
    assert.deepEqual(extractionTokens(state), { input: 7, output: 3 });
  });
});
