// Pure rules for the processing queue (no DB / network): who may be (re)processed or split, when a
// run counts as stuck, how OCR work is batched per tick, and how pipeline / vendor errors become
// Hebrew messages for the user. Used by src/lib/processingQueue.ts, the process / split routes and
// the review UI.

import type { InvoiceStatus } from '@/shared/types';
import { SPLITTABLE_STATUSES } from '@/shared/invoiceStatus';

/** Pipeline stages while status = 'processing' (invoices.processing_stage). */
export type ProcessingStage = 'queued' | 'ocr' | 'detect' | 'extract' | 'splitting';

/** Job stages (processing_jobs.stage); 'queued' on the invoice = job in 'ocr' with nothing done yet. */
export type JobStage = 'ocr' | 'detect' | 'extract';

export interface ProcessingProgress {
  pages_done: number;
  pages_total: number | null;
  /** Extraction of a long document runs in parts (src/shared/extractionChunks.ts). */
  parts_done?: number;
  parts_total?: number;
  /** Set while 'queued': how often this run was queued again after its job row vanished (QA round 4). */
  requeues?: number;
}

/**
 * A tick holds the job for this long. While its step runs it renews the lease every
 * JOB_HEARTBEAT_MS, and a tick that was killed (Amplify cut the request / froze the compute) frees
 * it within this time instead of minutes later (QA round 2, N5). Steps end before the deadline of
 * their request (TICK_RESPONSE_MS / the worker budget), well inside the lease.
 */
export const JOB_LEASE_MS = 45_000;
export const JOB_HEARTBEAT_MS = 10_000;
/** The heartbeat renews a step's lease for at most this long (a hung call must not hold the job forever). */
export const MAX_STEP_MS = 5 * 60_000;
/** Time budget of one tick for OCR batches (also bounded by the tick's deadline). */
export const TICK_OCR_BUDGET_MS = 14_000;
/**
 * Deadline of the work inside one /process/tick request. Nothing runs after a response on Amplify
 * (Lambda, no waitUntil: code after the response is frozen until another request thaws the instance,
 * QA round 3), so a tick only starts a step it can finish by then: OCR rounds are budgeted, LLM calls
 * get a timeout that ends before it, and a step that can't fit is left for the next tick.
 * 23 s: an LLM step that starts right away gets the whole MAX_LLM_CALL_MS, and the answer still
 * leaves well before Amplify's ~28 s cut.
 */
export const TICK_RESPONSE_MS = 23_000;
/** /process/tick and the worker answer by then whatever happens (Amplify answers a bare 504 at ~28 s). */
export const TICK_HARD_LIMIT_MS = 26_000;
/** Time kept after a step's last external call for saving its result before the deadline. */
export const STEP_SAVE_MARGIN_MS = 2_500;
/**
 * One LLM call never runs longer than this. Sonnet writes ~60-80 tokens/s, so ~1.2-1.6k output tokens
 * fit; extraction calls are streamed, so a part that needs more is cut here with its partial tool
 * input kept, and split in two while it has several pages (src/agents/extraction).
 */
export const MAX_LLM_CALL_MS = 20_000;
/**
 * A step with an LLM call (boundary detection, an extraction part) starts only with this much time
 * left, so its call always gets at least LLM_FULL_WINDOW_MS: in practice an LLM step runs at the start
 * of a request (one per tick / worker slot), never squeezed into the end of one (QA round 3 review).
 */
export const MIN_LLM_STEP_MS = 18_000;
/**
 * A call that ran out of time with at least this long a timeout is really too long for one call (its
 * part is split, or a one-page part keeps its partial result); one with a shorter timeout only started
 * late and is retried as a transient failure instead.
 */
export const LLM_FULL_WINDOW_MS = MIN_LLM_STEP_MS - STEP_SAVE_MARGIN_MS;
/**
 * Optional LLM steps (boundary detection, the math re-read) are retried this many times on transient
 * failures; then the run goes on without them (no split suggestion / the first-pass result) instead
 * of failing.
 */
export const OPTIONAL_STEP_TRANSIENT_RETRIES = 2;
/** An OCR step (download + at least one batch of pages) starts only with this much time left. */
export const MIN_OCR_STEP_MS = 7_000;
/** Validation + save (no LLM) starts only with this much time left. */
export const MIN_FINALIZE_STEP_MS = 5_000;
/** A run claimed this recently whose job row isn't written yet is still starting (N11). */
export const ENQUEUE_GRACE_MS = 60_000;
/** Pages sent to Google Vision in one files:annotate call (Vision's own maximum is 5). */
export const OCR_PAGES_PER_REQUEST = 5;
/** OCR requests run in parallel within a tick. */
export const OCR_PARALLEL_REQUESTS = 2;
/** A stage that failed this many times without progress with a real (not transient) error fails the run. */
export const MAX_STAGE_ATTEMPTS = 3;
/**
 * Transient failures (network drops, timeouts, 429 / 5xx, a tick interrupted with its lease held)
 * have a budget of their own, with backoff (transientBackoffMs), so they don't burn
 * MAX_STAGE_ATTEMPTS: a run fails on them only after this many in a row without progress (QA round 3).
 */
export const MAX_TRANSIENT_ATTEMPTS = 6;
/** No job activity for this long while 'processing' and nothing queued → the run is stuck. */
export const STALE_PROCESSING_MS = 10 * 60_000;
/** A run older than this is stuck even if it keeps heart-beating. */
export const MAX_RUN_MS = 45 * 60_000;
/**
 * A run whose job row disappeared before any step ran (still 'queued') is queued again after
 * ENQUEUE_GRACE_MS, at most this many times in a row; then it fails (QA round 4).
 */
export const MAX_LOST_JOB_REQUEUES = 2;
/** Documents with at least this many pages get the "split it" hint when a run runs out of time. */
export const LONG_DOCUMENT_PAGES = 10;
/**
 * The worker reports jobs that become due within this long as `soon` (a job in a short transient
 * backoff), so its caller calls again instead of waiting for the next minute (QA round 4).
 */
export const DUE_SOON_MS = 15_000;
/** `next_due_in_ms` of the worker looks this far ahead (null beyond). */
export const NEXT_DUE_HORIZON_MS = 20_000;

export const STAGE_LABELS: Record<ProcessingStage, string> = {
  queued: 'ממתין לעיבוד',
  ocr: 'מזהה טקסט (OCR)',
  detect: 'בודק אם הקובץ מכיל כמה מסמכים',
  extract: 'מחלץ נתונים',
  splitting: 'מפצל את הקובץ',
};

/** "מזהה טקסט (OCR) · 10/22 עמודים" for the review list. */
export function describeProgress(stage: string | null | undefined, progress: ProcessingProgress | null | undefined): string {
  const label = (stage && STAGE_LABELS[stage as ProcessingStage]) || 'בעיבוד';
  if (progress && progress.pages_total && progress.pages_total > 1 && (stage === 'ocr' || stage === 'queued')) {
    return `${label} · ${Math.min(progress.pages_done, progress.pages_total)}/${progress.pages_total} עמודים`;
  }
  if (progress && stage === 'extract' && progress.parts_total && progress.parts_total > 1) {
    return `${label} · חלק ${Math.min((progress.parts_done ?? 0) + 1, progress.parts_total)}/${progress.parts_total}`;
  }
  return label;
}

// ── Reprocess / split guards ───────────────────────────────────────────────────

export type ProcessDecision =
  | { ok: true }
  | { ok: false; status: 409; error: string };

export interface ProcessGuardInput {
  status: InvoiceStatus | string | null | undefined;
  /** True while another run is active and not stale. */
  activeRun: boolean;
}

/**
 * Who may be (re)processed (state machine: src/shared/invoiceStatus.ts, via 'reprocess'): a fresh
 * upload / split part / retried document ('processing' with no active run, or a stuck run), 'review'
 * and 'error'. An approved invoice must first be reopened explicitly (POST /reopen, logged); exported,
 * rejected and returned never (their data already left the office or belongs to the review-loop flow).
 */
export function canProcess(input: ProcessGuardInput): ProcessDecision {
  const { status, activeRun } = input;
  switch (status) {
    case 'processing':
      return activeRun
        ? { ok: false, status: 409, error: 'החשבונית כבר בעיבוד - יש להמתין לסיומו' }
        : { ok: true };
    case 'review':
    case 'error':
      return { ok: true };
    case 'approved':
      return { ok: false, status: 409, error: 'החשבונית כבר אושרה. כדי לעבד אותה מחדש יש לפתוח אותה מחדש במפורש' };
    case 'exported':
      return { ok: false, status: 409, error: 'החשבונית כבר יוצאה להנהלת החשבונות ולא ניתן לעבד אותה מחדש' };
    case 'rejected':
      return { ok: false, status: 409, error: 'החשבונית סומנה כלא מאושרת ולא ניתן לעבד אותה מחדש' };
    case 'returned':
      return { ok: false, status: 409, error: 'החשבונית הוחזרה ללקוח ולא ניתן לעבד אותה מחדש' };
    default:
      return { ok: false, status: 409, error: 'לא ניתן לעבד את החשבונית במצב הנוכחי' };
  }
}

/** Statuses a manual split may start from: the state machine's (src/shared/invoiceStatus.ts). */
export { SPLITTABLE_STATUSES };

export function splitStatusError(status: string | null | undefined): string | null {
  if ((SPLITTABLE_STATUSES as readonly string[]).includes(status ?? '')) return null;
  if (status === 'processing') return 'לא ניתן לפצל חשבונית שנמצאת בעיבוד - יש להמתין לסיומו';
  if (status === 'approved') return 'לא ניתן לפצל חשבונית שכבר אושרה';
  if (status === 'exported') return 'לא ניתן לפצל חשבונית שכבר יוצאה';
  return 'לא ניתן לפצל את החשבונית במצב הנוכחי';
}

// ── Stuck runs ────────────────────────────────────────────────────────────────

export interface StaleCheckInput {
  now: number;
  /** invoices.processing_started_at (null for rows from before the queue existed). */
  startedAt: string | null | undefined;
  /** Last job activity (processing_jobs.updated_at), null when no job exists. */
  lastActivityAt: string | null | undefined;
  /** invoices.updated_at / created_at, the fallback when nothing else is known. */
  rowUpdatedAt: string | null | undefined;
}

function ts(value: string | null | undefined): number | null {
  if (!value) return null;
  const n = Date.parse(value);
  return Number.isFinite(n) ? n : null;
}

/** True when a run started more than MAX_RUN_MS ago (a run with queued work is otherwise resumed, not failed). */
export function isRunTooOld(startedAt: string | null | undefined, now: number): boolean {
  const started = ts(startedAt);
  return started !== null && now - started > MAX_RUN_MS;
}

/** True when a 'processing' row has made no progress for STALE_PROCESSING_MS or ran past MAX_RUN_MS. */
export function isStaleRun(input: StaleCheckInput): boolean {
  const started = ts(input.startedAt);
  if (started !== null && input.now - started > MAX_RUN_MS) return true;
  // The latest thing known starts the clock: a run queued late (an old processing_started_at or row
  // date, but a fresh enqueue / job) is not stale (QA round 3)
  const known = [ts(input.lastActivityAt), started, ts(input.rowUpdatedAt)].filter((n): n is number => n !== null);
  if (known.length === 0) return false;
  return input.now - Math.max(...known) > STALE_PROCESSING_MS;
}

/**
 * 'enqueue': never queued, queue it. 'requeue': queued, but its job row vanished before any step ran;
 * queue it again. 'fail': give up (stuck). 'wait': not yet.
 */
export type OrphanRunAction = 'enqueue' | 'requeue' | 'fail' | 'wait';

export interface OrphanRunInput {
  now: number;
  /** invoices.processing_attempts: 0 / null = this row was never queued. */
  attempts: number | null | undefined;
  processingStage: string | null | undefined;
  startedAt: string | null | undefined;
  rowUpdatedAt: string | null | undefined;
  /** How often this run was already queued again after losing its job (processing_progress.requeues). */
  requeues?: number | null;
}

function pastGrace(input: OrphanRunInput): boolean {
  const known = [ts(input.startedAt), ts(input.rowUpdatedAt)].filter((n): n is number => n !== null);
  return known.length === 0 || input.now - Math.max(...known) >= ENQUEUE_GRACE_MS;
}

/**
 * What to do with a 'processing' row that has no job of its current run. A row that was never
 * queued (processing_attempts 0: an upload whose enqueue didn't happen, rows from before the queue)
 * is queued once it is ENQUEUE_GRACE_MS old (a split creating its parts queues them itself moments
 * later), not failed as stuck (QA round 3). A run that was queued but lost its job before any step
 * ran (still 'queued': nothing to resume, nothing lost) is queued again after the same grace, at
 * most MAX_LOST_JOB_REQUEUES times, then failed (QA round 4). A manual split in progress
 * ('splitting') and a run that lost its job mid-way fail only when stale, so the user can retry.
 */
export function orphanRunAction(input: OrphanRunInput): OrphanRunAction {
  const stale = isStaleRun({ now: input.now, startedAt: input.startedAt, lastActivityAt: null, rowUpdatedAt: input.rowUpdatedAt });
  if (input.processingStage === 'splitting') return stale ? 'fail' : 'wait';
  if (!input.attempts) return pastGrace(input) ? 'enqueue' : 'wait';
  if (input.processingStage === 'queued') {
    if (!pastGrace(input)) return 'wait';
    return (input.requeues ?? 0) < MAX_LOST_JOB_REQUEUES ? 'requeue' : 'fail';
  }
  return stale ? 'fail' : 'wait';
}

/** Why a run is given up as stuck (the message depends on it). */
export type StuckCause = 'too_long' | 'no_progress' | 'lost_job';

/**
 * Hebrew message of a run given up as stuck. Splitting the file is suggested only for a long
 * multi-page document that ran out of time; a one-page image or a lost queue job just gets "retry"
 * (QA round 4).
 */
export function stuckRunMessage(cause: StuckCause, pageCount: number | null | undefined = null): string {
  if (cause === 'lost_job') return LOST_JOB_MESSAGE;
  if (cause === 'too_long' && typeof pageCount === 'number' && pageCount >= LONG_DOCUMENT_PAGES) return STUCK_LONG_RUN_MESSAGE;
  return STUCK_RUN_MESSAGE;
}

export const STUCK_RUN_MESSAGE = 'העיבוד נקטע ולא הסתיים. ניתן לנסות שוב ("עבד מחדש")';
export const STUCK_LONG_RUN_MESSAGE = 'עיבוד המסמך הארוך לא הסתיים בזמן. ניתן לנסות שוב ("עבד מחדש"), או לפצל אותו לחלקים קטנים יותר';
export const LOST_JOB_MESSAGE = 'העיבוד לא התחיל (המשימה בתור אבדה). ניתן לנסות שוב ("עבד מחדש")';
export const TOO_MANY_ATTEMPTS_MESSAGE = 'העיבוד נכשל שוב ושוב בשלב זה. ניתן לנסות שוב ("עבד מחדש"), ואם הקובץ גדול - לפצל אותו לחלקים קטנים יותר';
export const CONNECTION_ERROR_MESSAGE = 'החיבור לשירותי העיבוד נקטע שוב ושוב. ניתן לנסות שוב ("עבד מחדש") בעוד כמה דקות';
export const TRANSIENT_EXHAUSTED_MESSAGE = 'העיבוד נקטע שוב ושוב בגלל תקלה זמנית. ניתן לנסות שוב ("עבד מחדש") בעוד כמה דקות';
/** last_error of a job whose previous tick was interrupted (its lease ran out while the step ran). */
export const INTERRUPTED_STEP_ERROR = 'Step interrupted: the lease expired before the step finished';

/** Wait before retrying a step after its n-th transient failure in a row (5 s, 10 s, 20 s ... at most 2 min). */
export function transientBackoffMs(n: number): number {
  const k = Math.max(1, Math.floor(n));
  return Math.min(120_000, 5_000 * 2 ** (k - 1));
}

// ── OCR batching ──────────────────────────────────────────────────────────────

/** The 1-based page numbers OCR'd next: up to `perRequest * parallel` pages, grouped per request. */
export function nextOcrBatches(
  pagesDone: number,
  pageCount: number,
  perRequest: number = OCR_PAGES_PER_REQUEST,
  parallel: number = OCR_PARALLEL_REQUESTS
): number[][] {
  const batches: number[][] = [];
  let next = pagesDone + 1;
  while (batches.length < parallel && next <= pageCount) {
    const batch: number[] = [];
    for (let p = next; p < next + perRequest && p <= pageCount; p++) batch.push(p);
    batches.push(batch);
    next += batch.length;
  }
  return batches;
}

// ── Error messages ────────────────────────────────────────────────────────────

/** Error whose message is already meant for the user (Hebrew). */
export class UserFacingError extends Error {
  constructor(message: string, public readonly httpStatus: number = 422) {
    super(message);
    this.name = 'UserFacingError';
  }
}

const HEBREW = /[֐-׿]/;

/** Error codes of dropped / refused / timed-out connections (Node, undici). */
const TRANSIENT_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'ENETUNREACH', 'ENETDOWN',
  'EHOSTUNREACH', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CLOSED', 'UND_ERR_ABORTED',
]);
const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);
/** Error class names (Anthropic SDK, fetch / AbortSignal) of connection problems, timeouts and retryable statuses. */
const TRANSIENT_NAMES = new Set([
  'APIConnectionError', 'APIConnectionTimeoutError', 'RateLimitError', 'InternalServerError', 'TimeoutError', 'AbortError',
]);
const CONNECTION_TEXT = [
  'fetch failed', 'connection error', 'socket hang up', 'econnreset', 'econnrefused', 'network error',
  'network socket disconnected', 'other side closed', 'eai_again', 'und_err_socket', 'und_err_closed',
];
const TRANSIENT_TEXT = [
  ...CONNECTION_TEXT, 'timed out', 'timeout', 'etimedout', 'aborted', 'overloaded', 'rate limit', 'rate_limit',
  'too many requests', 'resource_exhausted', 'service unavailable', 'bad gateway', 'internal server error',
  'deadline_exceeded', 'lease expired', 'step interrupted',
];

function httpStatusOf(err: unknown): number | null {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : null;
}

function codeOf(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code.toUpperCase() : null;
}

/** The error and its causes (fetch wraps the socket error as `cause`), a few levels deep. */
function errorChain(err: unknown): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = err;
  while (current !== null && current !== undefined && chain.length < 5 && !chain.includes(current)) {
    chain.push(current);
    current = typeof current === 'object' ? (current as { cause?: unknown }).cause : undefined;
  }
  return chain;
}

function chainText(err: unknown): string {
  return errorChain(err)
    .map((e) => (e instanceof Error ? `${e.name} ${e.message} ${codeOf(e) ?? ''}` : String(e ?? '')))
    .join(' | ')
    .toLowerCase();
}

/** True for a dropped / refused connection ('fetch failed', the SDK's 'Connection error.', ECONNRESET...). */
export function isConnectionError(err: unknown): boolean {
  for (const e of errorChain(err)) {
    const code = codeOf(e);
    if (code && TRANSIENT_CODES.has(code) && !TIMEOUT_CODES.has(code)) return true;
    if (e instanceof Error && e.name === 'APIConnectionError') return true;
  }
  const text = chainText(err);
  return CONNECTION_TEXT.some((t) => text.includes(t));
}

/** True for a call that ran out of time (a step's deadline, the SDK's request timeout, ETIMEDOUT). */
export function isTimeoutError(err: unknown): boolean {
  for (const e of errorChain(err)) {
    if (e instanceof Error && (e.name === 'APIConnectionTimeoutError' || e.name === 'TimeoutError')) return true;
    const code = codeOf(e);
    if (code && TIMEOUT_CODES.has(code)) return true;
  }
  const text = chainText(err);
  return text.includes('timed out') || text.includes('timeout') || text.includes('deadline_exceeded');
}

/**
 * True for errors that say nothing about the document: network drops and interruptions, timeouts,
 * rate limits and 5xx of Anthropic / Google / Supabase. They get MAX_TRANSIENT_ATTEMPTS with backoff
 * instead of the MAX_STAGE_ATTEMPTS of real errors (QA round 3: a frozen compute broke its sockets,
 * and the resulting 'fetch failed' / 'Connection error.' ended runs as a generic failure).
 */
export function isTransientError(err: unknown): boolean {
  if (err instanceof UserFacingError || isPermanentError(err)) return false;
  const status = httpStatusOf(err);
  if (status !== null) {
    if (status === 408 || status === 409 || status === 425 || status === 429 || status >= 500) return true;
    if (status >= 400) return false;
  }
  for (const e of errorChain(err)) {
    if (e instanceof Error && TRANSIENT_NAMES.has(e.name)) return true;
    const code = codeOf(e);
    if (code && TRANSIENT_CODES.has(code)) return true;
  }
  const text = chainText(err);
  return TRANSIENT_TEXT.some((t) => text.includes(t));
}

/** The technical cause kept on the invoice when a run fails (processing_error_detail); never shown as is. */
export function errorDetail(err: unknown): string {
  return errorChain(err)
    .map((e) => {
      if (!(e instanceof Error)) return String(e ?? '');
      const code = codeOf(e);
      const status = httpStatusOf(e);
      return `${e.name}: ${e.message}${code ? ` [${code}]` : ''}${status !== null ? ` (status ${status})` : ''}`;
    })
    .filter(Boolean)
    .join(' <- ')
    .slice(0, 2000);
}

/**
 * True for errors a retry can't fix (bad / empty / unsupported file, vendor 400). Transient ones
 * (isTransientError) are retried with backoff up to MAX_TRANSIENT_ATTEMPTS, other errors up to
 * MAX_STAGE_ATTEMPTS.
 */
export function isPermanentError(err: unknown): boolean {
  if (err instanceof UserFacingError) return true;
  const text = (err instanceof Error ? err.message : String(err ?? '')).toLowerCase();
  return (
    text.includes('bad request') || text.includes('invalid_argument') || text.includes('no input file') ||
    text.includes('unsupported input file format') || text.includes('bad image data') ||
    text.includes('no pdf header') || text.includes('failed to parse pdf') ||
    text.includes('api key is not configured')
  );
}

/**
 * Maps any pipeline error (Google Vision, Anthropic, storage, pdf-lib...) to a short Hebrew message
 * for invoices.error_message / API bodies. The raw detail belongs in the server log only.
 */
export function toUserErrorMessage(err: unknown): string {
  if (err instanceof UserFacingError) return err.message;
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  const text = raw.toLowerCase();
  const status = typeof (err as { status?: unknown })?.status === 'number' ? (err as { status: number }).status : null;

  if (text.includes('no input file') || text.includes('empty file')) {
    return 'הקובץ ריק - יש להעלות קובץ אחר';
  }
  if (
    text.includes('unsupported input file format') || text.includes('bad image data') ||
    text.includes('no pdf header') || text.includes('failed to parse pdf') || text.includes('invalid pdf') ||
    text.includes('image processing error')
  ) {
    return 'הקובץ אינו PDF או תמונה תקינים - יש להעלות קובץ אחר';
  }
  if (text.includes('password') || text.includes('encrypted')) {
    return 'הקובץ מוגן בסיסמה - יש להעלות עותק ללא סיסמה';
  }
  if (text.includes('google cloud vision') && (text.includes('api key') || text.includes('permission') || text.includes('forbidden'))) {
    return 'שירות זיהוי הטקסט אינו זמין כרגע (הגדרות שרת). יש לפנות לתמיכה';
  }
  if (text.includes('api key is not configured') || text.includes('anthropic_api_key')) {
    return 'שירות הניתוח אינו מוגדר בשרת. יש לפנות לתמיכה';
  }
  if (status === 429 || text.includes('rate limit') || text.includes('rate_limit') || text.includes('quota') || text.includes('resource_exhausted')) {
    return 'שירות הניתוח עמוס כרגע. יש לנסות שוב בעוד כמה דקות';
  }
  if (status === 529 || text.includes('overloaded')) {
    return 'שירות הניתוח עמוס כרגע. יש לנסות שוב בעוד כמה דקות';
  }
  if (text.includes('timed out') || text.includes('timeout') || text.includes('etimedout') || text.includes('aborted')) {
    return 'העיבוד ארך זמן רב מדי. ניתן לנסות שוב, ואם הקובץ גדול - לפצל אותו';
  }
  if (text.includes('lease expired') || text.includes('step interrupted')) {
    return STUCK_RUN_MESSAGE;
  }
  // 'fetch failed', the Anthropic SDK's 'Connection error.', ECONNRESET, socket hang up...
  if (isConnectionError(err)) {
    return CONNECTION_ERROR_MESSAGE;
  }
  if (text.includes('service unavailable') || text.includes('bad gateway') || text.includes('internal server error')) {
    return 'שירות הניתוח החזיר שגיאה. יש לנסות שוב בעוד כמה דקות';
  }
  if (text.includes('download') || text.includes('retrieve invoice file') || text.includes('object not found')) {
    return 'לא ניתן היה לקרוא את הקובץ מהאחסון. יש להעלות אותו מחדש';
  }
  if (text.includes('google cloud vision')) {
    return 'זיהוי הטקסט בקובץ נכשל. ניתן לנסות שוב או להעלות קובץ באיכות טובה יותר';
  }
  if (status !== null && status >= 500) {
    return 'שירות הניתוח החזיר שגיאה. יש לנסות שוב בעוד כמה דקות';
  }
  // Short Hebrew messages from our own code (e.g. 'המודל לא החזיר נתוני חשבונית') pass through
  if (raw && HEBREW.test(raw) && raw.length <= 200 && !raw.includes('{')) return raw;
  return GENERIC_FAILURE_MESSAGE;
}

const GENERIC_FAILURE_MESSAGE = 'העיבוד נכשל. ניתן לנסות שוב ("עבד מחדש")';

/** Message of a run that ran out of transient attempts: its cause when known, never the generic one. */
export function transientFailureMessage(err: unknown): string {
  const message = toUserErrorMessage(err);
  return message === GENERIC_FAILURE_MESSAGE ? TRANSIENT_EXHAUSTED_MESSAGE : message;
}
