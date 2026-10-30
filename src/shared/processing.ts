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
}

/**
 * A tick holds the job for this long. While its step runs it renews the lease every
 * JOB_HEARTBEAT_MS, so a long LLM call keeps the job, and a tick that was killed (Amplify cut the
 * request / froze the compute) frees it within this time instead of minutes later (QA round 2, N5).
 */
export const JOB_LEASE_MS = 45_000;
export const JOB_HEARTBEAT_MS = 10_000;
/** The heartbeat renews a step's lease for at most this long (a hung call must not hold the job forever). */
export const MAX_STEP_MS = 5 * 60_000;
/** Time budget of one tick for OCR batches (well under the ~28 s Amplify response limit). */
export const TICK_OCR_BUDGET_MS = 14_000;
/** An extraction tick goes on to validation + save (no LLM) only if its LLM call ended within this. */
export const TICK_FINALIZE_BUDGET_MS = 15_000;
/**
 * /process/tick answers by then even if its step still runs (202 + state 'busy'; the step goes on
 * in the background under its lease), so the browser never gets a bare 504 (N14 / N22).
 */
export const TICK_RESPONSE_MS = 20_000;
/** A run claimed this recently whose job row isn't written yet is still starting (N11). */
export const ENQUEUE_GRACE_MS = 60_000;
/** Pages sent to Google Vision in one files:annotate call (Vision's own maximum is 5). */
export const OCR_PAGES_PER_REQUEST = 5;
/** OCR requests run in parallel within a tick. */
export const OCR_PARALLEL_REQUESTS = 2;
/** A stage claimed this many times without progress fails the run (killed / timed-out ticks). */
export const MAX_STAGE_ATTEMPTS = 3;
/** No job activity for this long while 'processing' and nothing queued → the run is stuck. */
export const STALE_PROCESSING_MS = 10 * 60_000;
/** A run older than this is stuck even if it keeps heart-beating. */
export const MAX_RUN_MS = 45 * 60_000;

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
  const last = ts(input.lastActivityAt) ?? started ?? ts(input.rowUpdatedAt);
  if (last === null) return false;
  return input.now - last > STALE_PROCESSING_MS;
}

export const STUCK_RUN_MESSAGE = 'העיבוד נקטע ולא הסתיים. ניתן לנסות שוב ("עבד מחדש"), ואם הקובץ גדול - לפצל אותו לחלקים קטנים יותר';
export const TOO_MANY_ATTEMPTS_MESSAGE = 'העיבוד נכשל שוב ושוב בשלב זה. ניתן לנסות שוב ("עבד מחדש"), ואם הקובץ גדול - לפצל אותו לחלקים קטנים יותר';

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

/**
 * True for errors a retry can't fix (bad / empty / unsupported file, vendor 400). Transient ones
 * (rate limits, 5xx, timeouts, network) are retried by the next tick, up to MAX_STAGE_ATTEMPTS.
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
  return 'העיבוד נכשל. ניתן לנסות שוב ("עבד מחדש")';
}
