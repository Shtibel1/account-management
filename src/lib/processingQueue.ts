import { randomUUID } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import { isClientStorageFileUrl } from '@/lib/ingestHelpers';
import { isMockMode, supabaseUrl } from '@/lib/supabaseConfig';
import type { ExtractedData, FewShotLookupState, OcrWord } from '@/shared/types';
import { pageRotationsFromWords } from '@/shared/orientation';
import { AUTO_SPLIT_ENABLED, AUTO_SPLIT_MIN_CONFIDENCE, shouldAutoSplit, validateSplitRanges, type PageRange, type SplitSuggestion } from '@/shared/documentSplit';
import { sha256Hex, splitPartHash } from '@/lib/fileHash';
import { DAMAGED_PDF_MESSAGE, checkStoredBytes, mimeFromFileName, readPdfPageCount } from '@/shared/uploadValidation';
import {
  DUE_SOON_MS,
  ENQUEUE_GRACE_MS,
  INTERRUPTED_STEP_ERROR,
  JOB_HEARTBEAT_MS,
  JOB_LEASE_MS,
  LLM_FULL_WINDOW_MS,
  MAX_LLM_CALL_MS,
  MAX_LOST_JOB_REQUEUES,
  MAX_STAGE_ATTEMPTS,
  MAX_STEP_MS,
  MAX_TRANSIENT_ATTEMPTS,
  MIN_FINALIZE_STEP_MS,
  MIN_LLM_STEP_MS,
  MIN_OCR_STEP_MS,
  NEXT_DUE_HORIZON_MS,
  OPTIONAL_STEP_TRANSIENT_RETRIES,
  STALE_PROCESSING_MS,
  STEP_SAVE_MARGIN_MS,
  TICK_OCR_BUDGET_MS,
  TICK_RESPONSE_MS,
  UserFacingError,
  canProcess,
  errorDetail,
  isPermanentError,
  isRunTooOld,
  isStaleRun,
  isTimeoutError,
  isTransientError,
  isUnreadableFileError,
  nextOcrBatches,
  orphanRunAction,
  stuckRunMessage,
  tooManyAttemptsMessage,
  toUserErrorMessage,
  transientBackoffMs,
  transientFailureMessage,
  type JobStage,
  type ProcessingProgress,
  type ProcessingStage,
} from '@/shared/processing';
import {
  amountsChunkIndex,
  chunkHint,
  chunkText,
  extractionTokens,
  initialExtractState,
  isValidExtractState,
  mergeChunkResults,
  nextChunkIndex,
  splitChunk,
  type ExtractState,
  type PageSpan,
} from '@/shared/extractionChunks';
import type { QueuedExtractionInput, QueuedExtractionOutcome } from '@/agents/supervisor';
import type { BoundaryDetectionResult } from '@/agents/splitter';

/**
 * Durable processing queue (finding #6, QA rounds 2 + 3). Amplify cuts every HTTP response at ~28 s,
 * and nothing runs after a response (SSR compute is a Lambda without waitUntil: work left in
 * next/server after() is frozen until a later request thaws the instance, its sockets break and its
 * lease lapses - QA round 3). So all work happens INSIDE requests, in steps that end before the
 * request's deadline:
 *
 *   enqueueProcessing()  - status guard, new run token, a processing_jobs row. Called by every entry
 *                          point (upload, email / WhatsApp, split, retry, /process). Returns at once.
 *   runProcessingTick()  - one bounded step: page-batched OCR within the time left, or boundary
 *                          detection, or ONE extraction call over a few pages (long documents are
 *                          extracted in parts, src/shared/extractionChunks.ts), or validation + save.
 *                          A step starts only if it fits before the deadline (MIN_*_STEP_MS), and its
 *                          external calls get timeouts that end before it. Every step's result is
 *                          stored in processing_jobs before the next starts, so a killed tick loses
 *                          only its own step. Transient failures (network, timeouts, 429 / 5xx, an
 *                          interrupted tick) are retried with backoff up to MAX_TRANSIENT_ATTEMPTS,
 *                          real errors up to MAX_STAGE_ATTEMPTS; then a Hebrew error, with the
 *                          technical cause kept in invoices.processing_error_detail.
 *   driveProcessing()    - ticks in a loop until a deadline (the scheduled worker).
 *   sweepStaleProcessing() - 'processing' rows without a job: never queued -> queued; queued but lost
 *                          / stuck for STALE_PROCESSING_MS (or older than MAX_RUN_MS) -> error.
 *
 * Ticks are driven by the scheduled worker (/api/invoices/worker, called every minute and again while
 * jobs are due) and by the browser (/api/invoices/[id]/process/tick while an invoice is shown as
 * processing), so progress never depends on one request living long or on an open screen.
 */

const JOBS = 'processing_jobs';
/** Pages of still-'queued' sweep candidates looked through for rows whose job vanished (QA round 4 review). */
const QUEUED_SCAN_PAGES = 5;
const SUPPORTED_MIME = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/tiff']);

interface InvoiceRow {
  id: string;
  client_id: string;
  file_url: string | null;
  file_name: string | null;
  status: string;
  processing_run_id?: string | null;
  processing_started_at?: string | null;
  processing_attempts?: number | null;
  processing_stage?: string | null;
  processing_progress?: ProcessingProgress | null;
  updated_at?: string | null;
  created_at?: string | null;
}

export interface JobRow {
  invoice_id: string;
  run_id: string;
  client_id: string;
  file_url: string;
  mime_type: string;
  stage: JobStage;
  page_count: number | null;
  pages_done: number;
  page_texts: string[];
  ocr_words: OcrWord[];
  ocr_confidence: number | null;
  detected_languages: string[] | null;
  ocr_op_count: number;
  split_suggestion: SplitSuggestion | null;
  split_detection_failed: boolean;
  split_input_tokens: number;
  split_output_tokens: number;
  /** Extraction progress (migration 20261030180000_qa2_pipeline2.sql); null until extraction starts. */
  extract_state?: ExtractState | null;
  /** Real (non-transient) failures of the current stage without progress. */
  stage_attempts: number;
  /** Transient failures / interruptions without progress (migration 20261030191000_qa3_processing_error_detail.sql). */
  transient_attempts?: number | null;
  /** Backoff after a transient failure: no tick takes the job before this. */
  retry_at?: string | null;
  lock_version: number;
  locked_until: string | null;
  last_error: string | null;
  updated_at?: string | null;
}

export interface ExtractCallInput {
  invoiceId: string;
  clientId: string;
  /** OCR text of the pages this call sees. */
  text: string;
  fileUrl: string;
  mimeType: string;
  /** Send the image itself (math retry of a one-page image). */
  useVision: boolean;
  retryHint: boolean;
  hint: string | null;
  allowLargeRetry: boolean;
  fewShot: FewShotLookupState;
  /** Time limit of the call: it must end before the tick's deadline. */
  timeoutMs: number;
}

export interface ExtractCallResult {
  data: ExtractedData;
  inputTokens: number;
  outputTokens: number;
  fewShotInvoiceIds: string[];
  /** The response was cut at max_tokens or at its time limit (its data may be incomplete). */
  truncated?: boolean;
  /** Cut at its time limit (streamed; the data written by then is kept), not at max_tokens. */
  timedOut?: boolean;
}

/** Time limit of one external call of a step (OCR batch, LLM call). */
export interface CallOptions {
  timeoutMs: number;
}

export type FinalizeInput = Omit<QueuedExtractionInput, 'costMetrics'> & {
  tokens: { input: number; output: number };
  ocrOpCount: number;
};

/** Everything a tick touches outside the DB, injectable for tests. */
export interface QueueDeps {
  db: SupabaseClient;
  now: () => number;
  /** Bytes of a stored file_url (a storage reference since QA #31) of this client. */
  fetchFile: (url: string, clientId: string, options: CallOptions) => Promise<Buffer>;
  ocrPdfPages: (file: Buffer, pdf: unknown, pages: number[], options: CallOptions) => Promise<{ pageTexts: string[]; ocrWords: OcrWord[] }>;
  loadPdf: (file: Buffer) => Promise<{ getPageCount(): number } | null>;
  ocrImage: (file: Buffer, options: CallOptions) => Promise<{ rawOcrText: string; ocrWords: OcrWord[]; confidence: number; detectedLanguages: string[] }>;
  detect: (pageTexts: string[], options: CallOptions) => Promise<BoundaryDetectionResult>;
  loadFewShot: (invoiceId: string, clientId: string, ocrText: string) => Promise<FewShotLookupState>;
  /** One extraction LLM call. */
  extract: (input: ExtractCallInput) => Promise<ExtractCallResult>;
  /** Validation + save of the merged extraction (no LLM). */
  finalize: (input: FinalizeInput) => Promise<QueuedExtractionOutcome>;
  ocrBudgetMs: number;
  /** Lease renewal interval while a step runs (0 = off, tests). */
  heartbeatMs: number;
  /** Builds and uploads the parts of an automatic split (src/lib/invoiceSplit.ts). */
  splitPdf: (file: Buffer, ranges: PageRange[], target: { clientId: string; fileName: string | null; tag: string }) => Promise<{ fileUrl: string; start_page: number; end_page: number }[]>;
  /** Automatic split of multi-document PDFs (AUTO_SPLIT_ENABLED / AUTO_SPLIT_MIN_CONFIDENCE env). */
  autoSplit: AutoSplitSettings;
}

export interface AutoSplitSettings {
  enabled: boolean;
  /** Overall detection confidence (0-1) from which a file is split without asking; below it the review screen suggests the split. */
  minConfidence: number;
}

/**
 * Auto-split settings from the environment: AUTO_SPLIT_ENABLED ('false' / '0' / 'off' turns it off)
 * and AUTO_SPLIT_MIN_CONFIDENCE (0.5-1, or a percentage 50-100). Defaults: on, 0.9.
 */
export function autoSplitSettings(env: Record<string, string | undefined> = process.env): AutoSplitSettings {
  const rawEnabled = (env.AUTO_SPLIT_ENABLED ?? '').trim().toLowerCase();
  const enabled = rawEnabled === '' ? AUTO_SPLIT_ENABLED : !['false', '0', 'off', 'no'].includes(rawEnabled);
  let minConfidence = AUTO_SPLIT_MIN_CONFIDENCE;
  const text = (env.AUTO_SPLIT_MIN_CONFIDENCE ?? '').trim();
  const raw = Number(text);
  if (text !== '' && Number.isFinite(raw)) {
    const value = raw > 1 ? raw / 100 : raw;
    if (value >= 0.5 && value <= 1) minConfidence = value;
  }
  return { enabled, minConfidence };
}

async function defaultDeps(): Promise<QueueDeps> {
  const pre = await import('@/agents/preprocessor');
  const splitter = await import('@/agents/splitter');
  const supervisor = await import('@/agents/supervisor');
  const extraction = await import('@/agents/extraction');
  const fewshot = await import('@/lib/fewshot');
  const files = await import('@/lib/invoiceFiles');
  const splitting = await import('@/lib/invoiceSplit');
  return {
    db: supabase,
    now: () => Date.now(),
    // file_url is a storage reference (not a link, QA #31): read it through a short-lived signed URL
    fetchFile: async (url, clientId, options) => {
      return pre.fetchInvoiceFile((await files.signedInvoiceFileUrl(url, clientId, files.PIPELINE_URL_TTL_SECONDS)) ?? url, options.timeoutMs);
    },
    ocrPdfPages: (file, pdf, pages, options) => pre.ocrPdfPages(file, pdf as Awaited<ReturnType<typeof pre.loadPdf>>, pages, options),
    loadPdf: pre.loadPdf,
    ocrImage: pre.ocrImage,
    detect: (pageTexts, options) => splitter.detectDocumentBoundaries(pageTexts, undefined, options.timeoutMs),
    loadFewShot: (invoiceId, clientId, ocrText) => fewshot.loadFewShotExamples(supabase, { invoiceId, tenantId: clientId, ocrText }),
    extract: async (input) => {
      // An image is sent to the model as bytes when asked (vision) and also when its OCR text is
      // empty, so it is always read through a signed URL (file_url is a storage reference, QA #31)
      const fileUrl = input.mimeType.startsWith('image/')
        ? (await files.signedInvoiceFileUrl(input.fileUrl, input.clientId, files.PIPELINE_URL_TTL_SECONDS)) ?? input.fileUrl
        : input.fileUrl;
      const r = await extraction.extractInvoiceData(input.text, fileUrl, input.mimeType, input.useVision, input.retryHint, input.fewShot, {
        hint: input.hint,
        allowLargeRetry: input.allowLargeRetry,
        timeoutMs: input.timeoutMs,
      });
      return {
        data: r.extractedData,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        fewShotInvoiceIds: r.fewShotInvoiceIds,
        truncated: r.truncated,
        timedOut: r.timedOut,
      };
    },
    finalize: (input) => {
      const { tokens, ocrOpCount, ...rest } = input;
      const metrics = { ocrOpCount, inputTokens: tokens.input, outputTokens: tokens.output, estimatedCostUsd: 0 };
      metrics.estimatedCostUsd = supervisor.calculateEstimatedCost(metrics);
      return supervisor.finalizeQueuedExtraction({ ...rest, costMetrics: metrics });
    },
    ocrBudgetMs: TICK_OCR_BUDGET_MS,
    heartbeatMs: JOB_HEARTBEAT_MS,
    splitPdf: splitting.splitPdfIntoStoredParts,
    autoSplit: autoSplitSettings(),
  };
}

let depsOverride: Partial<QueueDeps> | null = null;
/** Test hook: replace some dependencies (null restores the defaults). */
export function setQueueDepsForTests(overrides: Partial<QueueDeps> | null): void {
  depsOverride = overrides;
}
async function deps(): Promise<QueueDeps> {
  const base = depsOverride?.db && depsOverride.fetchFile && depsOverride.extract && depsOverride.finalize
    ? ({ now: () => Date.now(), ocrBudgetMs: TICK_OCR_BUDGET_MS, heartbeatMs: 0, autoSplit: { enabled: false, minConfidence: AUTO_SPLIT_MIN_CONFIDENCE } } as QueueDeps)
    : await defaultDeps();
  return { ...base, ...(depsOverride ?? {}) } as QueueDeps;
}

const iso = (ms: number) => new Date(ms).toISOString();

const INVOICE_COLUMNS =
  'id, client_id, file_url, file_name, status, processing_run_id, processing_started_at, processing_attempts, processing_stage, processing_progress, updated_at, created_at';

async function readInvoice(db: SupabaseClient, invoiceId: string): Promise<InvoiceRow | null> {
  const { data, error } = await db
    .from('invoices')
    .select(INVOICE_COLUMNS)
    .eq('id', invoiceId)
    .single();
  if (error || !data) return null;
  return data as unknown as InvoiceRow;
}

async function readJob(db: SupabaseClient, invoiceId: string): Promise<JobRow | null> {
  const { data, error } = await db.from(JOBS).select('*').eq('invoice_id', invoiceId).limit(1);
  if (error) throw new Error(`processing_jobs read failed: ${error.message}`);
  const rows = (data ?? []) as JobRow[];
  return rows[0] ?? null;
}

function pickMimeType(hint: unknown, fileName: string | null): string {
  if (typeof hint === 'string' && SUPPORTED_MIME.has(hint)) return hint;
  return mimeFromFileName(fileName ?? '') ?? ((fileName ?? '').toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'image/jpeg');
}

// ── Columns of migration 20261030191000 (the app keeps working until it is applied) ──

/** processing_jobs.transient_attempts / retry_at are missing: transient failures then count as real ones. */
let transientColumnsUnsupported = false;
/** invoices.processing_error_detail is missing: the technical cause stays in the server log only. */
let errorDetailUnsupported = false;

function isMissingColumn(error: { message?: string; code?: string } | null | undefined, column: RegExp): boolean {
  if (!error) return false;
  const text = error.message ?? '';
  return column.test(text) && (error.code === 'PGRST204' || error.code === '42703' || /(column|schema cache)/i.test(text));
}

const TRANSIENT_COLUMNS = /transient_attempts|retry_at/;

function withoutTransientColumns<T extends Record<string, unknown>>(patch: T): T {
  if (!transientColumnsUnsupported) return patch;
  const { transient_attempts: _t, retry_at: _r, ...rest } = patch as Record<string, unknown>;
  return rest as T;
}

type JobUpdateQuery = ReturnType<ReturnType<SupabaseClient['from']>['update']>;
interface WriteResult {
  data: unknown;
  error: { message: string; code?: string } | null;
}

/**
 * processing_jobs update with `where` filters; returns the updated keys. Retried once without the
 * migration-20261030191000 columns when the DB doesn't have them yet.
 */
async function updateJobRows(d: QueueDeps, patch: Record<string, unknown>, where: (q: JobUpdateQuery) => JobUpdateQuery): Promise<WriteResult> {
  const run = async () => (await where(d.db.from(JOBS).update(withoutTransientColumns(patch))).select('invoice_id')) as WriteResult;
  let result = await run();
  if (result.error && !transientColumnsUnsupported && isMissingColumn(result.error, TRANSIENT_COLUMNS)) {
    transientColumnsUnsupported = true;
    console.warn('[Queue] processing_jobs.transient_attempts / retry_at are missing (migration 20261030191000 not applied); transient failures count as real ones.');
    result = await run();
  }
  return result;
}

/** Keeps the technical cause of a failed run on the invoice (best-effort; the user sees error_message only). */
async function saveErrorDetail(d: QueueDeps, invoiceId: string, detail: string | null): Promise<void> {
  if (errorDetailUnsupported) return;
  try {
    const { error } = await d.db.from('invoices').update({ processing_error_detail: detail ? detail.slice(0, 2000) : null }).eq('id', invoiceId);
    if (!error) return;
    if (isMissingColumn(error, /processing_error_detail/)) {
      errorDetailUnsupported = true;
      console.warn('[Queue] invoices.processing_error_detail is missing (migration 20261030191000 not applied).');
      return;
    }
    console.warn(`[Queue] Could not store the error detail of invoice ${invoiceId}:`, error.message);
  } catch (err) {
    console.warn(`[Queue] Could not store the error detail of invoice ${invoiceId}:`, err);
  }
}

// ── Enqueue ──────────────────────────────────────────────────────────────────

export type EnqueueResult =
  | { ok: true; runId: string; alreadyQueued?: boolean }
  | { ok: false; httpStatus: 400 | 404 | 409 | 500; error: string };

export interface EnqueueOptions {
  mimeType?: unknown;
  /**
   * The processing_run_id the caller itself claimed the row with (manual split: the split route
   * holds the row in 'processing' under its own token while it builds the parts). That claim is not
   * a competing run, so it doesn't count as live (else part 1 of every split got 409, QA round 2).
   */
  claimToken?: string | null;
  /**
   * A live run of a 'processing' row is the answer, not a conflict: ok with that run's id and
   * `alreadyQueued`. For /process, which a browser may still call after the server already queued
   * the upload / retry itself (QA round 3); a stuck run is still replaced.
   */
  reuseActiveRun?: boolean;
  /**
   * The run replaces one that lost its job row before any step ran (QA round 4): stored in
   * processing_progress.requeues, which caps how often that happens in a row.
   */
  requeues?: number;
  /**
   * OCR already done for this file (a part of an automatic split: its pages were read with the
   * whole file). The job then starts at extraction instead of reading the pages again.
   */
  seed?: JobSeed;
}

/** OCR results a new job starts from (see EnqueueOptions.seed). */
export interface JobSeed {
  page_texts: string[];
  ocr_words: OcrWord[];
  ocr_confidence: number | null;
  detected_languages: string[] | null;
  ocr_op_count: number;
  split_input_tokens: number;
  split_output_tokens: number;
}

/**
 * True while the invoice has a live run: a job of the current run that is not stuck, or a run
 * claimed moments ago whose job row isn't written yet. The second case closes the window between
 * the claim and the job insert, in which a concurrent /process used to see "no job", take the run
 * over and start a second one (QA round 2, N11).
 */
async function hasActiveRun(d: QueueDeps, invoice: InvoiceRow, ownClaim: string | null = null): Promise<boolean> {
  if (invoice.status !== 'processing' || !invoice.processing_run_id) return false;
  if (ownClaim && invoice.processing_run_id === ownClaim) return false;
  const job = await readJob(d.db, invoice.id);
  if (job && job.run_id === invoice.processing_run_id) {
    return !isStaleRun({ now: d.now(), startedAt: invoice.processing_started_at, lastActivityAt: job.updated_at, rowUpdatedAt: invoice.updated_at });
  }
  const started = invoice.processing_started_at ? Date.parse(invoice.processing_started_at) : NaN;
  return Number.isFinite(started) && d.now() - started < ENQUEUE_GRACE_MS;
}

/**
 * Queues a (re)processing run. Refuses approved (reopen it first), exported, rejected and returned
 * invoices and invoices with a live run (409, or the live run with `reuseActiveRun`). The claim is
 * conditioned on the status and run token just read, and a freshly claimed run counts as live even
 * before its job row exists, so of several concurrent requests exactly one starts a run.
 * The claim sets processing_started_at and updated_at, so the stale clock starts at the enqueue.
 */
export async function enqueueProcessing(invoiceId: string, options: EnqueueOptions = {}): Promise<EnqueueResult> {
  const d = await deps();
  const invoice = await readInvoice(d.db, invoiceId);
  if (!invoice) return { ok: false, httpStatus: 404, error: 'החשבונית לא נמצאה' };

  const activeRun = await hasActiveRun(d, invoice, options.claimToken ?? null);
  if (activeRun && options.reuseActiveRun && invoice.processing_run_id) {
    return { ok: true, runId: invoice.processing_run_id, alreadyQueued: true };
  }
  const decision = canProcess({ status: invoice.status, activeRun });
  if (!decision.ok) return { ok: false, httpStatus: decision.status, error: decision.error };

  if (!invoice.file_url) {
    await d.db.from('invoices').update({
      status: 'error',
      error_message: 'לחשבונית אין קובץ שמור - יש להעלות אותה מחדש',
      updated_at: iso(d.now()),
    }).eq('id', invoiceId);
    return { ok: false, httpStatus: 400, error: 'לחשבונית אין קובץ שמור - יש להעלות אותה מחדש' };
  }
  // file_url is user-editable (PATCH / RLS): only our own storage URLs for this client are fetched.
  if (!isMockMode() && !isClientStorageFileUrl(invoice.file_url, invoice.client_id, process.env.SUPABASE_URL || supabaseUrl())) {
    console.error(`[Queue] Refusing untrusted file URL for invoice ${invoiceId}`);
    await d.db.from('invoices').update({
      status: 'error',
      error_message: 'קובץ החשבונית אינו קובץ אחסון של הלקוח - יש להעלות אותו מחדש',
      updated_at: iso(d.now()),
    }).eq('id', invoiceId);
    return { ok: false, httpStatus: 400, error: 'קובץ החשבונית אינו קובץ אחסון של הלקוח - יש להעלות אותו מחדש' };
  }

  const runId = randomUUID();
  const now = d.now();
  let claim = d.db
    .from('invoices')
    .update({
      status: 'processing',
      processing_run_id: runId,
      processing_started_at: iso(now),
      processing_attempts: (invoice.processing_attempts ?? 0) + 1,
      processing_stage: 'queued' satisfies ProcessingStage,
      processing_progress: {
        pages_done: 0,
        pages_total: null,
        ...(options.requeues ? { requeues: options.requeues } : {}),
      } satisfies ProcessingProgress,
      error_message: null,
      updated_at: iso(now),
    })
    .eq('id', invoiceId)
    .eq('status', invoice.status);
  claim = invoice.processing_run_id ? claim.eq('processing_run_id', invoice.processing_run_id) : claim.is('processing_run_id', null);
  const { data: claimed, error: claimErr } = await claim.select('id');
  if (claimErr) {
    console.error(`[Queue] Claim failed for invoice ${invoiceId}:`, claimErr);
    return { ok: false, httpStatus: 500, error: 'לא ניתן היה להתחיל את העיבוד. יש לנסות שוב' };
  }
  if (!Array.isArray(claimed) || claimed.length === 0) {
    if (options.reuseActiveRun) {
      // Lost the race to a concurrent enqueue: that run is the answer
      const current = await readInvoice(d.db, invoiceId);
      if (current?.status === 'processing' && current.processing_run_id) {
        return { ok: true, runId: current.processing_run_id, alreadyQueued: true };
      }
    }
    return { ok: false, httpStatus: 409, error: 'החשבונית כבר בעיבוד - יש להמתין לסיומו' };
  }

  await d.db.from(JOBS).delete().eq('invoice_id', invoiceId);
  const { error: jobErr } = await d.db.from(JOBS).insert({
    invoice_id: invoiceId,
    run_id: runId,
    client_id: invoice.client_id,
    file_url: invoice.file_url,
    mime_type: pickMimeType(options.mimeType, invoice.file_name),
    ...(options.seed
      ? {
          stage: 'extract',
          page_count: options.seed.page_texts.length,
          pages_done: options.seed.page_texts.length,
          page_texts: options.seed.page_texts,
          ocr_words: options.seed.ocr_words,
          ocr_confidence: options.seed.ocr_confidence,
          detected_languages: options.seed.detected_languages,
          ocr_op_count: options.seed.ocr_op_count,
          split_input_tokens: options.seed.split_input_tokens,
          split_output_tokens: options.seed.split_output_tokens,
        }
      : { stage: 'ocr', pages_done: 0, page_texts: [], ocr_words: [], ocr_op_count: 0, split_input_tokens: 0, split_output_tokens: 0 }),
    split_detection_failed: false,
    stage_attempts: 0,
    lock_version: 0,
    locked_until: null,
    updated_at: iso(now),
  });
  if (jobErr) {
    console.error(`[Queue] Could not create the job of invoice ${invoiceId}:`, jobErr);
    await failRun(d, invoiceId, runId, 'לא ניתן היה להתחיל את העיבוד. יש לנסות שוב', `enqueue: job insert failed: ${jobErr.message}`);
    return { ok: false, httpStatus: 500, error: 'לא ניתן היה להתחיל את העיבוד. יש לנסות שוב' };
  }
  // The detail of an earlier failed run doesn't describe this one
  await saveErrorDetail(d, invoiceId, null);
  console.log(`[Queue] Invoice ${invoiceId} queued (run ${runId}).`);
  return { ok: true, runId };
}

// ── Failing / finishing a run ────────────────────────────────────────────────

/**
 * Ends a run as 'error' with a Hebrew message. `detail` (the technical cause) is kept on the invoice
 * (processing_error_detail), since the job row - and its last_error - is deleted here.
 */
async function failRun(d: QueueDeps, invoiceId: string, runId: string | null, message: string, detail: string | null = null): Promise<void> {
  let query = d.db.from('invoices').update({
    status: 'error',
    error_message: message,
    processing_stage: null,
    processing_progress: null,
    updated_at: iso(d.now()),
  }).eq('id', invoiceId).eq('status', 'processing');
  query = runId ? query.eq('processing_run_id', runId) : query;
  const { data, error } = await query.select('id');
  if (error) console.error(`[Queue] Could not mark invoice ${invoiceId} as failed:`, error);
  else if (Array.isArray(data) && data.length > 0) await saveErrorDetail(d, invoiceId, detail ?? message);
  await deleteJob(d, invoiceId, runId);
}

/**
 * Removes the job of `runId` only: a tick of a superseded run that finishes late must not delete
 * the job a newer run (re-process / split) already created for the same invoice.
 */
async function deleteJob(d: QueueDeps, invoiceId: string, runId: string | null): Promise<void> {
  let query = d.db.from(JOBS).delete().eq('invoice_id', invoiceId);
  if (runId) query = query.eq('run_id', runId);
  await query;
}

async function setInvoiceProgress(d: QueueDeps, job: JobRow, stage: ProcessingStage, progress: ProcessingProgress): Promise<void> {
  await d.db.from('invoices').update({
    processing_stage: stage,
    processing_progress: progress,
    updated_at: iso(d.now()),
  }).eq('id', job.invoice_id).eq('processing_run_id', job.run_id);
}

/** Thrown when another tick took the job over (this tick's lease expired) or the run was replaced. */
class LostJobLockError extends Error {
  constructor(invoiceId: string) {
    super(`Lost the job lock of invoice ${invoiceId}`);
    this.name = 'LostJobLockError';
  }
}

/**
 * A streamed extraction call was cut at its time limit, and its partial result isn't kept: it had a
 * short window (it started late), or a one-page part gets one more try. A timeout, so the step is
 * retried with backoff on the transient budget.
 */
class CallCutLateError extends Error {
  constructor(timeoutMs: number, retryOnce = false) {
    super(retryOnce
      ? `Extraction call timed out at its ${timeoutMs} ms limit; retrying the page once before keeping a partial result`
      : `Extraction call timed out at its ${timeoutMs} ms limit (started late); retrying with a full window`);
    this.name = 'TimeoutError';
  }
}

/**
 * Saves job fields; conditioned on the lock version this tick holds (throws LostJobLockError otherwise).
 * Progress (stage_attempts reset to 0) also resets the transient counter.
 */
async function saveJob(d: QueueDeps, job: JobRow, patch: Partial<JobRow>): Promise<void> {
  const full: Partial<JobRow> = patch.stage_attempts === 0 ? { transient_attempts: 0, retry_at: null, ...patch } : patch;
  const { data, error } = await updateJobRows(d, { ...full, updated_at: iso(d.now()) }, (q) =>
    q.eq('invoice_id', job.invoice_id).eq('lock_version', job.lock_version).eq('run_id', job.run_id)
  );
  if (error) throw new Error(`processing_jobs update failed: ${error.message}`);
  if (!Array.isArray(data) || data.length === 0) throw new LostJobLockError(job.invoice_id);
  Object.assign(job, full);
}

/**
 * Renews the lease of the job this tick holds every `heartbeatMs` while its step runs. Only while
 * the lease is still held (lock_version unchanged, not released, not expired): a beat can never
 * re-lock a job the step already released, nor revive a lease that ran out (a frozen step thawing).
 * Steps end before their request's deadline, well inside the lease; if the compute is frozen or
 * killed anyway, the beats stop and the lease runs out after JOB_LEASE_MS, and the next tick takes
 * over (counted as an interruption, a transient failure).
 */
function startHeartbeat(d: QueueDeps, job: JobRow): () => void {
  if (!d.heartbeatMs || d.heartbeatMs <= 0) return () => {};
  const lockVersion = job.lock_version;
  const startedAt = d.now();
  const timer = setInterval(() => {
    const now = d.now();
    // A step that hangs (a call that never returns) must not hold the job forever: after
    // MAX_STEP_MS the beats stop, the lease runs out and another tick retries the step.
    if (now - startedAt > MAX_STEP_MS) {
      clearInterval(timer);
      return;
    }
    try {
      void Promise.resolve(
        d.db.from(JOBS)
          .update({ locked_until: iso(now + JOB_LEASE_MS), updated_at: iso(now) })
          .eq('invoice_id', job.invoice_id)
          .eq('lock_version', lockVersion)
          .gt('locked_until', iso(now))
      ).then(({ error }) => {
        if (error) console.warn(`[Queue] Lease renewal failed for invoice ${job.invoice_id}:`, error.message);
      }, (err) => console.warn(`[Queue] Lease renewal failed for invoice ${job.invoice_id}:`, err));
    } catch (err) {
      console.warn(`[Queue] Lease renewal failed for invoice ${job.invoice_id}:`, err);
    }
  }, d.heartbeatMs);
  (timer as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
}

// ── Tick ─────────────────────────────────────────────────────────────────────

export type TickState =
  | 'done'      // not processing any more (review / approved / error / ...)
  | 'pending'   // more work left; call again
  | 'busy'      // another tick holds the job, or it waits for its retry backoff
  | 'waiting'   // processing, but nothing queued yet (a fresh row whose enqueue is still due)
  | 'failed';   // this tick marked the invoice as error

export interface TickResult {
  state: TickState;
  stage?: ProcessingStage | null;
  progress?: ProcessingProgress | null;
  /** 'pending' without work done: the next step doesn't fit before this tick's deadline. */
  deferred?: boolean;
  /** 'busy' because of a retry backoff: not before this time. */
  retryAt?: string | null;
  /** The tick split the file automatically: ids of all parts (the first is this invoice). */
  splitInto?: string[];
}

export interface TickOptions {
  /**
   * Epoch ms by which the tick's work must be done (its request answers right after). Default:
   * TICK_RESPONSE_MS from now. Nothing may run after the response (Amplify freezes it).
   */
  deadline?: number;
}

function jobProgress(job: JobRow): ProcessingProgress {
  const progress: ProcessingProgress = { pages_done: job.pages_done, pages_total: job.page_count };
  const st = job.extract_state;
  if (job.stage === 'extract' && st && Array.isArray(st.results) && st.results.length > 1) {
    progress.parts_done = st.results.filter((r) => r !== null).length;
    progress.parts_total = st.results.length;
  }
  return progress;
}

/** Time a tick needs left before its deadline to start this job's next step. */
export function minStepMs(job: Pick<JobRow, 'stage' | 'extract_state'> & { split_suggestion?: SplitSuggestion | null }): number {
  if (job.stage === 'ocr') return MIN_OCR_STEP_MS;
  // A detected split waiting to be carried out: no LLM call, only file work
  if (job.stage === 'detect' && job.split_suggestion) return MIN_SPLIT_STEP_MS;
  if (job.stage === 'extract' && job.extract_state?.phase === 'finalize') return MIN_FINALIZE_STEP_MS;
  return MIN_LLM_STEP_MS;
}

/** Time limit of an external call that starts now: ends STEP_SAVE_MARGIN_MS before the deadline. */
function callTimeoutMs(d: QueueDeps, deadline: number, cap: number = MAX_LLM_CALL_MS): number {
  return Math.max(1_000, Math.min(cap, deadline - d.now() - STEP_SAVE_MARGIN_MS));
}

/**
 * Transient failures of the current step so far (optional-step retries). Without migration
 * 20261030191000 they are counted as real ones, in stage_attempts.
 */
function transientTries(job: JobRow): number {
  return transientColumnsUnsupported ? job.stage_attempts : job.transient_attempts ?? 0;
}

/** The technical cause of a step failure, for processing_error_detail. */
function stepDetail(job: JobRow, kind: string, cause: unknown): string {
  return `stage ${job.stage}, ${kind} (real ${job.stage_attempts}/${MAX_STAGE_ATTEMPTS}, transient ${job.transient_attempts ?? 0}/${MAX_TRANSIENT_ATTEMPTS}): ${typeof cause === 'string' ? cause : errorDetail(cause)}`;
}

/**
 * One bounded step of an invoice's run, finished before `options.deadline`. Safe to call
 * concurrently and repeatedly: the job lease (optimistic lock_version + locked_until) lets one tick
 * work at a time; the others answer 'busy'.
 */
export async function runProcessingTick(invoiceId: string, options: TickOptions = {}): Promise<TickResult> {
  const d = await deps();
  const deadline = options.deadline ?? d.now() + TICK_RESPONSE_MS;
  // The job is read before the invoice: an enqueue in between then shows up as a newer run on the
  // invoice (this job really is superseded), never as a "stale" invoice next to the new run's job.
  // Deletes are conditioned on the job's own run, so a new run's job is never removed.
  let job = await readJob(d.db, invoiceId);
  const invoice = await readInvoice(d.db, invoiceId);
  if (!invoice) return { state: 'done' };

  if (invoice.status !== 'processing') {
    if (job) await deleteJob(d, invoiceId, job.run_id);
    return { state: 'done' };
  }

  if (!job || job.run_id !== invoice.processing_run_id) {
    if (job) await deleteJob(d, invoiceId, job.run_id); // left over from a superseded run
    return handleOrphanRun(d, invoice);
  }

  const now = d.now();
  const lockedUntil = job.locked_until ? Date.parse(job.locked_until) : null;
  if (lockedUntil !== null && lockedUntil > now) {
    return { state: 'busy', stage: job.stage, progress: jobProgress(job) };
  }
  const retryAt = job.retry_at ? Date.parse(job.retry_at) : null;
  if (retryAt !== null && retryAt > now) {
    return { state: 'busy', stage: job.stage, progress: jobProgress(job), retryAt: job.retry_at };
  }

  // A queued job whose lease is free is resumed, however long nobody drove it (N4: "nobody ticked
  // it" is not a failure). Failing ticks are bounded by the attempt budgets, endless runs by MAX_RUN_MS.
  if (isRunTooOld(invoice.processing_started_at, now)) {
    console.warn(`[Queue] Run ${job.run_id} of invoice ${invoiceId} ran too long; marking as error.`);
    await failRun(d, invoiceId, job.run_id, stuckRunMessage('too_long', job.page_count), stepDetail(job, 'run older than MAX_RUN_MS', job.last_error ?? 'no error recorded'));
    return { state: 'failed' };
  }

  // Only a step that can end before the deadline is started (nothing may run after the response)
  if (deadline - now < minStepMs(job)) {
    return { state: 'pending', stage: job.stage, progress: jobProgress(job), deferred: true };
  }

  // Claim: only the tick that bumps the version it read gets the job. A lease that ran out (not
  // released) means the previous tick was interrupted mid-step - a transient failure, not a real one.
  const interrupted = lockedUntil !== null;
  const nextVersion = job.lock_version + 1;
  const counted: Partial<JobRow> = !interrupted
    ? {}
    : transientColumnsUnsupported
      ? { stage_attempts: job.stage_attempts + 1, last_error: INTERRUPTED_STEP_ERROR }
      : { transient_attempts: (job.transient_attempts ?? 0) + 1, last_error: INTERRUPTED_STEP_ERROR };
  const { data: claimed, error: claimErr } = await updateJobRows(d, {
    lock_version: nextVersion,
    locked_until: iso(now + JOB_LEASE_MS),
    retry_at: null,
    ...counted,
    updated_at: iso(now),
  }, (q) => q.eq('invoice_id', invoiceId).eq('lock_version', job!.lock_version));
  if (claimErr) throw new Error(`processing_jobs claim failed: ${claimErr.message}`);
  if (!Array.isArray(claimed) || claimed.length === 0) return { state: 'busy', stage: job.stage };
  // The fallback above may have dropped transient_attempts (migration missing): count it as real then
  if (interrupted && transientColumnsUnsupported && counted.transient_attempts !== undefined) {
    counted.stage_attempts = job.stage_attempts + 1;
    delete counted.transient_attempts;
    await updateJobRows(d, { stage_attempts: counted.stage_attempts }, (q) => q.eq('invoice_id', invoiceId).eq('lock_version', nextVersion));
  }
  job = { ...job, ...counted, lock_version: nextVersion, locked_until: iso(now + JOB_LEASE_MS), retry_at: null };

  if (interrupted) {
    console.warn(`[Queue] Stage ${job.stage} of invoice ${invoiceId} was interrupted (lease expired); retrying it.`);
    if ((job.transient_attempts ?? 0) >= MAX_TRANSIENT_ATTEMPTS) {
      await failRun(d, invoiceId, job.run_id, transientFailureMessage(INTERRUPTED_STEP_ERROR), stepDetail(job, 'interrupted too often', INTERRUPTED_STEP_ERROR));
      return { state: 'failed' };
    }
    if (job.stage_attempts >= MAX_STAGE_ATTEMPTS) {
      await failRun(d, invoiceId, job.run_id, tooManyAttemptsMessage(job.page_count), stepDetail(job, 'interrupted too often', INTERRUPTED_STEP_ERROR));
      return { state: 'failed' };
    }
  }

  const stopHeartbeat = startHeartbeat(d, job);
  try {
    if (job.stage === 'ocr') return await ocrStep(d, job, deadline);
    if (job.stage === 'detect') return await detectStep(d, job, deadline);
    return await extractStep(d, job, deadline);
  } catch (err) {
    if (err instanceof LostJobLockError) {
      // Another tick (or a new run) owns the job now: leave it alone
      console.warn(`[Queue] ${err.message}; stopping this tick.`);
      return { state: 'busy', stage: job.stage };
    }
    return await handleStepError(d, job, err);
  } finally {
    stopHeartbeat();
  }
}

/**
 * A step threw. Transient errors (network, timeouts, 429 / 5xx) release the job with a backoff and
 * count against MAX_TRANSIENT_ATTEMPTS; real errors are retried at once up to MAX_STAGE_ATTEMPTS;
 * permanent ones (bad file) fail the run at once. The results of earlier steps stay in the job.
 */
async function handleStepError(d: QueueDeps, job: JobRow, err: unknown): Promise<TickResult> {
  const invoiceId = job.invoice_id;
  const transient = isTransientError(err) && !transientColumnsUnsupported;
  const lastError = errorDetail(err) || 'unknown error';
  if (transient) {
    const attempts = (job.transient_attempts ?? 0) + 1;
    console.warn(`[Queue] Transient failure of invoice ${invoiceId} (stage ${job.stage}, ${attempts}/${MAX_TRANSIENT_ATTEMPTS}): ${lastError}`);
    if (attempts >= MAX_TRANSIENT_ATTEMPTS) {
      await failRun(d, invoiceId, job.run_id, transientFailureMessage(err), stepDetail({ ...job, transient_attempts: attempts }, 'transient', err));
      return { state: 'failed' };
    }
    const retryAt = iso(d.now() + transientBackoffMs(attempts));
    await updateJobRows(d, {
      locked_until: null,
      retry_at: retryAt,
      transient_attempts: attempts,
      last_error: lastError,
      updated_at: iso(d.now()),
    }, (q) => q.eq('invoice_id', invoiceId).eq('lock_version', job.lock_version));
    return { state: 'busy', stage: job.stage, retryAt };
  }

  const attempts = job.stage_attempts + 1;
  console.error(`[Queue] Tick failed for invoice ${invoiceId} (stage ${job.stage}, attempt ${attempts}/${MAX_STAGE_ATTEMPTS}):`, err);
  if (isPermanentError(err) || attempts >= MAX_STAGE_ATTEMPTS) {
    await failRun(d, invoiceId, job.run_id, toUserErrorMessage(err), stepDetail({ ...job, stage_attempts: attempts }, 'error', err));
    return { state: 'failed' };
  }
  // The next tick retries this step only (the results of earlier steps are already stored in the job)
  await updateJobRows(d, {
    locked_until: null,
    stage_attempts: attempts,
    last_error: lastError,
    updated_at: iso(d.now()),
  }, (q) => q.eq('invoice_id', invoiceId).eq('lock_version', job.lock_version));
  return { state: 'pending', stage: job.stage };
}

/** 'already': another request queued it meanwhile. */
type OrphanOutcome = 'queued' | 'already' | 'failed' | 'waiting';

/** Requeues of the current run (processing_progress.requeues, set only while it is 'queued'). */
function requeuesOf(invoice: InvoiceRow): number {
  const n = invoice.processing_progress?.requeues;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * A 'processing' row without a job of its run (tick and sweep): queue it (never queued, or queued
 * but its job vanished before any step ran), fail it (stuck) or wait. `via` only labels the log.
 */
async function resolveOrphanRun(d: QueueDeps, invoice: InvoiceRow, via: 'tick' | 'sweep'): Promise<OrphanOutcome> {
  const requeues = requeuesOf(invoice);
  const action = orphanRunAction({
    now: d.now(),
    attempts: invoice.processing_attempts,
    processingStage: invoice.processing_stage,
    startedAt: invoice.processing_started_at,
    rowUpdatedAt: invoice.updated_at ?? invoice.created_at,
    requeues,
  });
  if (action === 'enqueue' || action === 'requeue') {
    const queued = await enqueueProcessing(invoice.id, { reuseActiveRun: true, ...(action === 'requeue' ? { requeues: requeues + 1 } : {}) });
    if (queued.ok) {
      if (queued.alreadyQueued) return 'already';
      console.log(action === 'enqueue'
        ? `[Queue] Invoice ${invoice.id} was never queued; queued it now (${via}).`
        : `[Queue] The queued job of invoice ${invoice.id} (run ${invoice.processing_run_id ?? '-'}) vanished before it started; queued it again (${requeues + 1}/${MAX_LOST_JOB_REQUEUES}, ${via}).`);
      return 'queued';
    }
    console.warn(`[Queue] Could not queue invoice ${invoice.id} without a job (${via}): ${queued.error}`);
    return 'waiting';
  }
  if (action === 'fail') {
    // Queued but its job is gone (requeues used up, or lost mid-way and stale), or a split that
    // never finished: give up so it can be retried
    const lostBeforeStart = invoice.processing_stage === 'queued';
    const detail = lostBeforeStart
      ? `job of run ${invoice.processing_run_id ?? '-'} vanished before any step ran, ${requeues} requeue(s) already (${via})`
      : `no job of run ${invoice.processing_run_id ?? '-'} for ${Math.round(STALE_PROCESSING_MS / 60_000)} min (${via}, stage ${invoice.processing_stage ?? '-'})`;
    const message = lostBeforeStart ? stuckRunMessage('lost_job') : stuckRunMessage('no_progress');
    await failRun(d, invoice.id, invoice.processing_run_id ?? null, message, detail);
    return 'failed';
  }
  return 'waiting';
}

async function handleOrphanRun(d: QueueDeps, invoice: InvoiceRow): Promise<TickResult> {
  const outcome = await resolveOrphanRun(d, invoice, 'tick');
  if (outcome === 'queued' || outcome === 'already') return { state: 'pending', stage: 'queued' };
  if (outcome === 'failed') return { state: 'failed' };
  return { state: 'waiting', stage: 'queued' };
}

async function ocrStep(d: QueueDeps, job: JobRow, deadline: number): Promise<TickResult> {
  const started = d.now();
  // The download is bounded too (up to 20 MB): a slow one must not push the answer past the deadline
  const file = await d.fetchFile(job.file_url, job.client_id, { timeoutMs: callTimeoutMs(d, deadline, Number.POSITIVE_INFINITY) });
  // Reject what Vision can't read before calling it (empty, oversized, not a PDF / image)
  const check = checkStoredBytes(file);
  if (!check.ok) throw new UserFacingError(check.error);

  if (check.mimeType !== 'application/pdf') {
    const img = await d.ocrImage(file, { timeoutMs: callTimeoutMs(d, deadline, Number.POSITIVE_INFINITY) });
    await saveJob(d, job, {
      page_count: 1, pages_done: 1, page_texts: [img.rawOcrText], ocr_words: img.ocrWords,
      ocr_confidence: img.confidence, detected_languages: img.detectedLanguages, ocr_op_count: 1,
      mime_type: check.mimeType, stage: 'extract', stage_attempts: 0, locked_until: null, last_error: null,
    });
    await setInvoiceProgress(d, job, 'extract', { pages_done: 1, pages_total: 1 });
    return { state: 'pending', stage: 'extract', progress: { pages_done: 1, pages_total: 1 } };
  }

  const pdf = await d.loadPdf(file);
  // pdf-lib loads some damaged files without throwing and fails only on their page tree (QA round 4):
  // that file can't be read by anyone, so the run fails at once instead of being retried
  const counted = pdf ? readPdfPageCount(pdf) : 1;
  if (counted === null) throw new UserFacingError(DAMAGED_PDF_MESSAGE);
  const pageCount = counted;
  if (pageCount < 1) throw new UserFacingError('קובץ ה-PDF אינו מכיל עמודים');
  if (job.page_count !== pageCount) {
    await saveJob(d, job, { page_count: pageCount, mime_type: 'application/pdf' });
  }
  await setInvoiceProgress(d, job, 'ocr', { pages_done: job.pages_done, pages_total: pageCount });

  // OCR a few pages at a time, saving after each round. A new round starts only if it is expected
  // to end within the tick's budget and before its deadline (estimated from the previous round).
  // At least one round per tick (the claim checked MIN_OCR_STEP_MS), so a slow download can't stall the run.
  const budget = Math.min(d.ocrBudgetMs, deadline - started - STEP_SAVE_MARGIN_MS);
  let lastRoundMs = 0;
  let rounds = 0;
  while (job.pages_done < pageCount && (rounds === 0 || d.now() - started + lastRoundMs < budget)) {
    rounds++;
    const roundStarted = d.now();
    const batches = nextOcrBatches(job.pages_done, pageCount);
    const timeoutMs = callTimeoutMs(d, deadline, Number.POSITIVE_INFINITY);
    let results: Awaited<ReturnType<QueueDeps['ocrPdfPages']>>[];
    try {
      results = await Promise.all(batches.map((pages) => d.ocrPdfPages(file, pdf, pages, { timeoutMs })));
    } catch (err) {
      // pdf-lib couldn't parse the file and Vision rejects it too: it is damaged, not "not a PDF"
      // (QA round 5 #3). Permanent: the run fails at once.
      if (!pdf && isUnreadableFileError(err)) throw new UserFacingError(DAMAGED_PDF_MESSAGE);
      throw err;
    }
    const done = batches.reduce((n, b) => n + b.length, 0);
    await saveJob(d, job, {
      pages_done: job.pages_done + done,
      page_texts: [...job.page_texts, ...results.flatMap((r) => r.pageTexts)],
      ocr_words: [...job.ocr_words, ...results.flatMap((r) => r.ocrWords)],
      ocr_op_count: job.ocr_op_count + batches.length,
      // progress resets the attempt counters: only a stage that makes no progress fails the run
      stage_attempts: 0,
      last_error: null,
    });
    await setInvoiceProgress(d, job, 'ocr', { pages_done: job.pages_done, pages_total: pageCount });
    lastRoundMs = d.now() - roundStarted;
  }

  const progress = { pages_done: job.pages_done, pages_total: pageCount };
  if (job.pages_done >= pageCount) {
    const next: JobStage = pageCount > 1 ? 'detect' : 'extract';
    await saveJob(d, job, { stage: next, stage_attempts: 0, locked_until: null });
    await setInvoiceProgress(d, job, next, progress);
    return { state: 'pending', stage: next, progress };
  }
  await saveJob(d, job, { locked_until: null });
  return { state: 'pending', stage: 'ocr', progress };
}

/** Time a tick needs left to carry out an automatic split (download, split, uploads, rows, enqueues). */
export const MIN_SPLIT_STEP_MS = 9_000;

/** True when this detection result is split automatically (multi-document, confident enough, fits the file). */
function autoSplitApplies(d: QueueDeps, job: JobRow, suggestion: SplitSuggestion | null): suggestion is SplitSuggestion {
  if (!suggestion || job.mime_type !== 'application/pdf') return false;
  if (!shouldAutoSplit(suggestion, d.autoSplit.enabled, d.autoSplit.minConfidence)) return false;
  const pageCount = job.page_count ?? job.page_texts.length;
  return suggestion.page_count === pageCount && validateSplitRanges(suggestion.documents, pageCount).ok;
}

async function detectStep(d: QueueDeps, job: JobRow, deadline: number): Promise<TickResult> {
  // A split suggestion stored while the stage is still 'detect' is an automatic split that is due
  if (job.split_suggestion) {
    if (autoSplitApplies(d, job, job.split_suggestion)) return autoSplitStep(d, job, deadline);
    // Settings changed meanwhile: go on with the suggestion for the reviewer
    return continueWithSuggestion(d, job);
  }
  let detection: BoundaryDetectionResult;
  try {
    // With a time limit, detect() throws transient failures (instead of "no suggestion")
    detection = await d.detect(job.page_texts, { timeoutMs: callTimeoutMs(d, deadline) });
  } catch (err) {
    // Detection is optional: retried a couple of times on transient failures, then the run goes on
    // without a split suggestion (flagged as failed for the reviewer) instead of failing
    if (!isTransientError(err) || transientTries(job) < OPTIONAL_STEP_TRANSIENT_RETRIES) throw err;
    console.warn(`[Queue] Boundary detection of invoice ${job.invoice_id} keeps failing; going on without a split suggestion:`, errorDetail(err));
    detection = { suggestion: null, inputTokens: 0, outputTokens: 0, failed: true };
  }
  if (autoSplitApplies(d, job, detection.suggestion)) {
    // Confident multi-document file: split it into parts that are processed on their own. The
    // suggestion is stored first (stage stays 'detect'), so a tick that is cut off resumes the split
    // without paying for detection again.
    console.log(`[Queue] Invoice ${job.invoice_id}: ${detection.suggestion.documents.length} documents (confidence ${detection.suggestion.confidence} >= ${d.autoSplit.minConfidence}); splitting automatically.`);
    await saveJob(d, job, {
      split_suggestion: detection.suggestion,
      split_detection_failed: false,
      split_input_tokens: detection.inputTokens,
      split_output_tokens: detection.outputTokens,
      stage_attempts: 0,
      last_error: null,
    });
    if (deadline - d.now() >= MIN_SPLIT_STEP_MS) return autoSplitStep(d, job, deadline);
    await saveJob(d, job, { locked_until: null });
    const progress = { pages_done: job.pages_done, pages_total: job.page_count };
    await setInvoiceProgress(d, job, 'splitting', progress);
    return { state: 'pending', stage: 'splitting', progress };
  }
  await saveJob(d, job, {
    split_suggestion: detection.suggestion,
    split_detection_failed: detection.failed === true,
    split_input_tokens: detection.inputTokens,
    split_output_tokens: detection.outputTokens,
    stage: 'extract',
    stage_attempts: 0,
    locked_until: null,
    last_error: null,
  });
  const progress = { pages_done: job.pages_done, pages_total: job.page_count };
  await setInvoiceProgress(d, job, 'extract', progress);
  return { state: 'pending', stage: 'extract', progress };
}

/** Detection is done and the file is not split automatically: extract it, suggesting the split in review. */
async function continueWithSuggestion(d: QueueDeps, job: JobRow): Promise<TickResult> {
  await saveJob(d, job, { stage: 'extract', stage_attempts: 0, locked_until: null, last_error: null });
  const progress = { pages_done: job.pages_done, pages_total: job.page_count };
  await setInvoiceProgress(d, job, 'extract', progress);
  return { state: 'pending', stage: 'extract', progress };
}

/**
 * Invoice id of part `index` (1-based, >= 2) of the automatic split of `runId`: deterministic, so a
 * retried split step finds the rows it already created instead of inserting them again.
 */
export function autoSplitPartId(runId: string, index: number): string {
  const h = sha256Hex(Buffer.from(`auto-split:${runId}:${index}`));
  // RFC 4122 shape (version 5 style, variant 10)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${h.slice(18, 20)}-${h.slice(20, 32)}`;
}

/** Lineage columns in a separate best-effort update (a missing column must not fail the split). */
async function saveSplitLineage(d: QueueDeps, invoiceId: string, lineage: Record<string, unknown>): Promise<void> {
  try {
    const { error } = await d.db.from('invoices').update(lineage).eq('id', invoiceId);
    if (error) throw error;
  } catch (err) {
    console.warn(`[Queue] Could not save the split lineage of invoice ${invoiceId}:`, err);
  }
}

async function saveFileHash(d: QueueDeps, invoiceId: string, hash: string): Promise<void> {
  try {
    const { error } = await d.db.from('invoices').update({ file_hash: hash }).eq('id', invoiceId);
    if (error) throw error;
  } catch (err) {
    console.warn(`[Queue] Could not save the file hash of invoice ${invoiceId}:`, err);
  }
}

/** The OCR of pages start..end (1-based) of the job, renumbered from page 1 for the part's own job. */
function partSeed(job: JobRow, range: PageRange, first: boolean): JobSeed {
  return {
    page_texts: job.page_texts.slice(range.start_page - 1, range.end_page),
    ocr_words: (job.ocr_words ?? [])
      .filter((w) => typeof w.page === 'number' && w.page >= range.start_page && w.page <= range.end_page)
      .map((w) => ({ ...w, page: (w.page as number) - range.start_page + 1 })),
    ocr_confidence: job.ocr_confidence,
    detected_languages: job.detected_languages,
    // The whole file's OCR and detection cost is counted once, on part 1
    ocr_op_count: first ? job.ocr_op_count : 0,
    split_input_tokens: first ? job.split_input_tokens : 0,
    split_output_tokens: first ? job.split_output_tokens : 0,
  };
}

/**
 * Automatic split (QA: multi-invoice PDFs came out as ONE review row; auto-split had been left off
 * behind AUTO_SPLIT_ENABLED = false since the splitter rewrite of 2026-10-30). Same result as the
 * manual split route: the invoice becomes part 1, one new invoice per further part ("<name>_חלק_<n>"),
 * the original file stays referenced from every part, part fingerprints derive from the source hash
 * and page range. Each part is queued as its own processing job, starting at extraction with its
 * pages' OCR (no second Vision pass). Safe to retry: part files go to fixed paths (upsert), the part
 * rows have ids derived from the run, and every write is conditioned on this run.
 * A file that can't be split (pdf-lib can't parse it, uploads keep failing) is extracted whole with
 * the split suggested in review, as before.
 */
async function autoSplitStep(d: QueueDeps, job: JobRow, deadline: number): Promise<TickResult> {
  const suggestion = job.split_suggestion as SplitSuggestion;
  const ranges: PageRange[] = suggestion.documents.map((doc) => ({ start_page: doc.start_page, end_page: doc.end_page }));
  const started = d.now();
  await setInvoiceProgress(d, job, 'splitting', { pages_done: job.pages_done, pages_total: job.page_count });

  const { data: rowData } = await d.db.from('invoices').select('file_name, file_hash').eq('id', job.invoice_id).limit(1);
  const row = (Array.isArray(rowData) ? rowData[0] : null) as { file_name?: string | null; file_hash?: string | null } | null;
  const fileName = row?.file_name || 'invoice.pdf';

  let file: Buffer;
  let parts: { fileUrl: string; start_page: number; end_page: number }[];
  try {
    file = await d.fetchFile(job.file_url, job.client_id, { timeoutMs: callTimeoutMs(d, deadline, Number.POSITIVE_INFINITY) });
    parts = await d.splitPdf(file, ranges, { clientId: job.client_id, fileName, tag: `auto_${job.run_id.slice(0, 8)}` });
  } catch (err) {
    if (err instanceof LostJobLockError) throw err;
    if (isTransientError(err) && transientTries(job) < OPTIONAL_STEP_TRANSIENT_RETRIES) throw err;
    console.warn(`[Queue] Automatic split of invoice ${job.invoice_id} failed; extracting it whole with the split suggested in review:`, errorDetail(err));
    return continueWithSuggestion(d, job);
  }

  const sourceHash = row?.file_hash || sha256Hex(file);
  const lineageBase = { original_file_url: job.file_url, original_file_name: fileName, original_file_hash: sourceHash };
  const { nameWithoutExt, ext } = (() => {
    const dot = fileName.lastIndexOf('.');
    return dot !== -1 ? { nameWithoutExt: fileName.slice(0, dot), ext: fileName.slice(dot) } : { nameWithoutExt: fileName, ext: '.pdf' };
  })();
  const partName = (idx: number) => `${nameWithoutExt}_חלק_${idx + 1}${ext}`;
  const now = iso(d.now());

  // 1. The invoice itself becomes part 1 - only while this run still owns it
  const first = parts[0];
  const { data: updated, error: updateErr } = await d.db
    .from('invoices')
    .update({
      file_url: first.fileUrl,
      file_name: partName(0),
      processing_stage: 'splitting' satisfies ProcessingStage,
      extracted_data: null,
      validated_data: null,
      ai_confidence: null,
      error_message: null,
      reviewed_at: null,
      updated_at: now,
    })
    .eq('id', job.invoice_id)
    .eq('processing_run_id', job.run_id)
    .select('id');
  if (updateErr) throw new Error(`auto-split: update of part 1 failed: ${updateErr.message}`);
  if (!Array.isArray(updated) || updated.length === 0) throw new LostJobLockError(job.invoice_id);
  await saveFileHash(d, job.invoice_id, splitPartHash(sourceHash, first.start_page, first.end_page));
  await saveSplitLineage(d, job.invoice_id, { ...lineageBase, split_start_page: first.start_page, split_end_page: first.end_page });

  // 2. One invoice per further part (created once: the id is derived from the run)
  const partIds: (string | null)[] = [job.invoice_id];
  for (let idx = 1; idx < parts.length; idx++) {
    const part = parts[idx];
    const id = autoSplitPartId(job.run_id, idx + 1);
    const { data: existing } = await d.db.from('invoices').select('id').eq('id', id).limit(1);
    if (!Array.isArray(existing) || existing.length === 0) {
      const { error: insertErr } = await d.db.from('invoices').insert({
        id,
        client_id: job.client_id,
        file_url: part.fileUrl,
        file_name: partName(idx),
        status: 'processing',
        created_at: now,
        updated_at: now,
      });
      if (insertErr) {
        console.error(`[Queue] Insert of part ${idx + 1} of invoice ${job.invoice_id} failed:`, insertErr);
        partIds.push(null);
        continue;
      }
    }
    await saveFileHash(d, id, splitPartHash(sourceHash, part.start_page, part.end_page));
    await saveSplitLineage(d, id, { ...lineageBase, split_parent_id: job.invoice_id, split_start_page: part.start_page, split_end_page: part.end_page });
    partIds.push(id);
  }

  // 3. Queue every part with its pages' OCR. Part 1's enqueue replaces this job (a new run on the
  // same row), so nothing of this job is written after it.
  const queued = await Promise.all(
    parts.map((part, idx) => {
      const id = partIds[idx];
      if (!id) return Promise.resolve(false);
      return enqueueProcessing(id, {
        mimeType: 'application/pdf',
        seed: partSeed(job, part, idx === 0),
        ...(idx === 0 ? { claimToken: job.run_id } : {}),
      }).then((r) => {
        if (!r.ok) console.error(`[Queue] Could not queue part ${idx + 1} (${id}) of invoice ${job.invoice_id}: ${r.error}`);
        return r.ok;
      }, (err) => {
        console.error(`[Queue] Queueing part ${idx + 1} (${id}) of invoice ${job.invoice_id} crashed:`, err);
        return false;
      });
    })
  );
  const created = partIds.filter(Boolean).length;
  console.log(`[Queue] Automatic split of invoice ${job.invoice_id}: ${created}/${parts.length} parts, ${queued.filter(Boolean).length} queued (${d.now() - started} ms).`);
  if (!queued[0]) {
    // Part 1 could not be queued: fail its run so it can be retried from the review screen
    await failRun(d, job.invoice_id, job.run_id, 'לא ניתן היה להתחיל את העיבוד. יש לנסות שוב', 'auto-split: enqueue of part 1 failed');
    return { state: 'failed' };
  }
  return { state: 'pending', stage: 'extract', progress: { pages_done: 0, pages_total: first.end_page - first.start_page + 1 }, splitInto: partIds.filter((x): x is string => !!x) };
}

/** True when the DB has no processing_jobs.extract_state yet (migration not applied). */
function isMissingExtractStateColumn(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err ?? '');
  return /extract_state/.test(text) && /(column|schema cache)/i.test(text);
}
let extractStateUnsupported = false;

function wordsInSpan(words: OcrWord[], span: PageSpan): OcrWord[] {
  return words.filter((w) => typeof w.page !== 'number' || (w.page >= span.start && w.page <= span.end));
}

/**
 * Extraction in resumable steps (QA round 2, N5 / N14 / N22; QA round 3). Each tick makes at most
 * ONE LLM call (one page chunk, or the math retry), with a timeout that ends before the tick's
 * deadline, and stores its result in processing_jobs.extract_state before it returns, so no request
 * has to outlive the Amplify limit and a killed tick re-pays only for its own call. Calls are
 * streamed and cut at their limit with what they wrote so far. A part whose call had the full
 * window (LLM_FULL_WINDOW_MS) and still ran out of time or of output tokens is split in two
 * (smaller calls fit); a one-page part is tried once more, then keeps its partial result. A call
 * cut only because it started late is retried as a transient failure, not split. The math re-read
 * is optional: cut or failing, the first-pass result is saved. When every chunk is in, the merged
 * result is validated and saved (no LLM), in the same tick if there is time left, else in the next.
 */
async function extractStep(d: QueueDeps, job: JobRow, deadline: number): Promise<TickResult> {
  const pageCount = job.page_count ?? Math.max(1, job.page_texts.length);
  let state: ExtractState = isValidExtractState(job.extract_state, pageCount)
    ? (job.extract_state as ExtractState)
    : initialExtractState(job.page_texts, pageCount, job.split_suggestion);
  const rangeText = chunkText(job.page_texts, state.range);
  let llmCalls = 0;

  /** Stores the state; false when it can't be stored (old DB): the step then goes on in memory. */
  const persist = async (next: ExtractState): Promise<boolean> => {
    state = next;
    job.extract_state = next;
    if (extractStateUnsupported) return false;
    try {
      await saveJob(d, job, { extract_state: next, stage_attempts: 0, last_error: null });
      return true;
    } catch (err) {
      if (err instanceof LostJobLockError || !isMissingExtractStateColumn(err)) throw err;
      extractStateUnsupported = true;
      console.warn('[Queue] processing_jobs.extract_state is missing (migration 20261030180000 not applied); extracting in one tick.');
      return false;
    }
  };
  /**
   * Keeps the tokens of a call whose result is thrown away, without counting progress (the attempt
   * counters stay as they are, so a part that keeps failing still runs out of attempts).
   */
  const keepTokens = async (discarded: { input: number; output: number }): Promise<void> => {
    state = { ...state, discarded_tokens: discarded };
    job.extract_state = state;
    if (extractStateUnsupported) return;
    await saveJob(d, job, { extract_state: state }).catch((err) => {
      if (err instanceof LostJobLockError) throw err;
      console.warn(`[Queue] Could not keep the tokens of a discarded call of invoice ${job.invoice_id}:`, err);
    });
  };
  /** Ends this tick after its LLM call; the next tick continues from the stored state. */
  const yieldTick = async (): Promise<TickResult> => {
    await saveJob(d, job, { locked_until: null });
    const progress = jobProgress(job);
    await setInvoiceProgress(d, job, 'extract', progress);
    return { state: 'pending', stage: 'extract', progress };
  };
  const canYield = () => !extractStateUnsupported;
  /** One LLM call per tick; a further one only without stored state (old DB) and with time left. */
  const mustYield = () => llmCalls > 0 && (canYield() || deadline - d.now() < MIN_LLM_STEP_MS);

  for (;;) {
    if (state.phase === 'chunks') {
      const index = nextChunkIndex(state);
      if (index === null) {
        state = { ...state, phase: 'finalize' };
        continue;
      }
      if (mustYield()) return yieldTick();
      const fewShot = state.few_shot ?? (await d.loadFewShot(job.invoice_id, job.client_id, rangeText));
      const span = state.chunks[index];
      const timeoutMs = callTimeoutMs(d, deadline);
      // Only a call that had (about) the whole window was really too long; one that started late
      // is retried later with a full window instead of breaking the part up for nothing
      const fullWindow = timeoutMs >= LLM_FULL_WINDOW_MS;
      const pages = span.start === span.end ? `page ${span.start}` : `pages ${span.start}-${span.end}`;
      let r: ExtractCallResult;
      const callStarted = d.now();
      try {
        r = await d.extract({
          invoiceId: job.invoice_id,
          clientId: job.client_id,
          text: chunkText(job.page_texts, span),
          fileUrl: job.file_url,
          mimeType: job.mime_type,
          useVision: false,
          retryHint: false,
          hint: chunkHint(state, index),
          // No 16k-token retry: such a call can't end before the deadline. A cut response of a
          // multi-page part is redone as two smaller parts instead (below).
          allowLargeRetry: false,
          fewShot,
          timeoutMs,
        });
      } catch (err) {
        // A timeout here means nothing was written in time (a streamed call keeps what it wrote)
        const smaller = isTimeoutError(err) && fullWindow ? splitChunk(state, index) : null;
        if (!smaller) throw err;
        console.warn(`[Queue] Extraction of ${pages} of invoice ${job.invoice_id} timed out (${timeoutMs} ms); splitting the part.`);
        llmCalls++;
        await persist({ ...smaller, few_shot: fewShot });
        continue;
      }
      llmCalls++;
      console.log(`[Queue] Extraction of ${pages} of invoice ${job.invoice_id}: ${d.now() - callStarted} ms (limit ${timeoutMs} ms, ${r.outputTokens} output tokens${r.timedOut ? ', cut at the limit' : r.truncated ? ', cut at max_tokens' : ''}).`);
      if (r.truncated) {
        const discarded = state.discarded_tokens ?? { input: 0, output: 0 };
        const discard = { input: discarded.input + r.inputTokens, output: discarded.output + r.outputTokens };
        if (r.timedOut && !fullWindow) {
          // Cut only because it started late: redo the same part with a full window (transient)
          await keepTokens(discard);
          throw new CallCutLateError(timeoutMs);
        }
        const smaller = splitChunk(state, index);
        if (smaller) {
          console.warn(`[Queue] Extraction of ${pages} of invoice ${job.invoice_id} was cut (${r.timedOut ? 'time limit' : 'max_tokens'}); splitting the part.`);
          await persist({ ...smaller, few_shot: fewShot, discarded_tokens: discard });
          continue;
        }
        if (r.timedOut && transientTries(job) < 1) {
          // A one-page part cut at the time limit: try it once more (the model's speed varies)
          await keepTokens(discard);
          throw new CallCutLateError(timeoutMs, true);
        }
        // Nothing smaller to try: keep what was written (validation flags what is missing)
        console.warn(`[Queue] Extraction of ${pages} of invoice ${job.invoice_id} was cut again; keeping the partial result.`);
      }
      const results = [...state.results];
      results[index] = { data: r.data, input_tokens: r.inputTokens, output_tokens: r.outputTokens };
      await persist({
        ...state,
        results,
        few_shot: fewShot,
        few_shot_ids: [...new Set([...state.few_shot_ids, ...r.fewShotInvoiceIds])],
      });
      continue;
    }

    if (state.phase === 'retry') {
      if (mustYield()) return yieldTick();
      // The sums didn't match: read the part with the amounts again, more carefully (once).
      // A one-page image is sent as the image itself, as the pipeline always did.
      const index = amountsChunkIndex(state);
      const previous = state.results[index];
      let r: ExtractCallResult;
      try {
        r = await d.extract({
          invoiceId: job.invoice_id,
          clientId: job.client_id,
          text: chunkText(job.page_texts, state.chunks[index]),
          fileUrl: job.file_url,
          mimeType: job.mime_type,
          useVision: job.mime_type.startsWith('image/') && state.chunks.length === 1,
          retryHint: true,
          hint: chunkHint(state, index),
          // A 16k-token retry can't end before the deadline
          allowLargeRetry: false,
          fewShot: state.few_shot ?? { examples: [], supplierVatId: null },
          timeoutMs: callTimeoutMs(d, deadline),
        });
      } catch (err) {
        // The re-read is optional: the first-pass result is already stored. A transient failure is
        // retried a couple of times; after that, or on a real error, the run is saved without it.
        if (err instanceof LostJobLockError) throw err;
        if (isTransientError(err) && transientTries(job) < OPTIONAL_STEP_TRANSIENT_RETRIES) throw err;
        console.warn(`[Queue] Math re-read of invoice ${job.invoice_id} failed; saving the first-pass result:`, errorDetail(err));
        llmCalls++;
        await persist({ ...state, retry_count: state.retry_count + 1, phase: 'finalize' });
        continue;
      }
      llmCalls++;
      const results = [...state.results];
      if (r.truncated && previous) {
        // A cut re-read may miss fields the first pass has: keep the first pass, count the tokens
        console.warn(`[Queue] Math re-read of invoice ${job.invoice_id} was cut; keeping the first-pass result.`);
        const discarded = state.discarded_tokens ?? { input: 0, output: 0 };
        await persist({
          ...state,
          discarded_tokens: { input: discarded.input + r.inputTokens, output: discarded.output + r.outputTokens },
          retry_count: state.retry_count + 1,
          phase: 'finalize',
        });
        continue;
      }
      results[index] = {
        data: r.data,
        input_tokens: (previous?.input_tokens ?? 0) + r.inputTokens,
        output_tokens: (previous?.output_tokens ?? 0) + r.outputTokens,
      };
      await persist({ ...state, results, retry_count: state.retry_count + 1, phase: 'finalize' });
      continue;
    }

    // finalize: validation + save, no LLM. After an LLM call it runs only if it still fits the deadline.
    if (llmCalls > 0 && deadline - d.now() < MIN_FINALIZE_STEP_MS && canYield()) return yieldTick();
    const tokens = extractionTokens(state);
    const outcome = await d.finalize({
      invoiceId: job.invoice_id,
      runId: job.run_id,
      tenantId: job.client_id,
      fileUrl: job.file_url,
      mimeType: job.mime_type,
      extractedData: mergeChunkResults(state),
      retryCount: state.retry_count,
      rawOcrText: rangeText,
      ocrMetadata: {
        pageCount,
        detectedLanguages: job.detected_languages && job.detected_languages.length > 0 ? job.detected_languages : ['he'],
        confidence: job.ocr_confidence ?? 0.95,
      },
      ocrWords: wordsInSpan(job.ocr_words ?? [], state.range),
      pageRotations: pageRotationsFromWords(job.ocr_words),
      splitSuggestion: job.split_suggestion,
      splitDetectionFailed: job.split_detection_failed,
      fewShotExampleIds: state.few_shot_ids,
      learnedRules: state.few_shot?.learnedRules ?? [],
      tokens: { input: tokens.input + job.split_input_tokens, output: tokens.output + job.split_output_tokens },
      ocrOpCount: job.ocr_op_count,
    });
    if (outcome.outcome === 'retry') {
      await persist({ ...state, phase: 'retry' });
      continue;
    }
    await deleteJob(d, job.invoice_id, job.run_id);
    return { state: 'done' };
  }
}

// ── Drivers ──────────────────────────────────────────────────────────────────

/**
 * Runs ticks back to back until the run ends, another tick holds it, the next step doesn't fit
 * before `deadline` (epoch ms), or the deadline is reached. Everything ends before the deadline.
 */
export async function driveProcessing(invoiceId: string, deadline: number): Promise<TickResult> {
  let last: TickResult = { state: 'pending', deferred: true };
  while (Date.now() < deadline - MIN_FINALIZE_STEP_MS) {
    last = await runProcessingTick(invoiceId, { deadline });
    if (last.state !== 'pending' || last.deferred) break;
  }
  return last;
}

export interface SweepResult {
  /** Invoices marked as error (stuck). */
  failed: string[];
  /** 'processing' rows that were never queued and are queued now. */
  enqueued: string[];
}

/**
 * Looks at 'processing' invoices with no fresh activity: a row without a job of its run is queued
 * when it was never queued (processing_attempts 0) or lost its job before any step ran (still
 * 'queued', up to MAX_LOST_JOB_REQUEUES times, QA round 4), and marked as error (retry allowed) when
 * it was queued but made no progress for STALE_PROCESSING_MS; a run older than MAX_RUN_MS is marked as
 * error too. A run with a queued job is left to the ticks, which resume it. `clientIds` limits the
 * sweep (null = all, for the scheduled worker).
 */
export async function sweepStaleProcessing(clientIds: string[] | null = null, limit = 100): Promise<SweepResult> {
  const d = await deps();
  const result: SweepResult = { failed: [], enqueued: [] };
  if (clientIds && clientIds.length === 0) return result;
  // Only rows that may need action, so a long queue of live jobs can't crowd them out (QA round 3
  // review): never-queued and still-'queued' rows past the enqueue grace, and rows without any change
  // for STALE_PROCESSING_MS (a stale run has an old updated_at; a live job's steps keep bumping it).
  const candidates = (cutoffMs: number, kind: 'never-queued' | 'queued' | 'stale', after?: string) => {
    let query = d.db
      .from('invoices')
      .select(INVOICE_COLUMNS)
      .eq('status', 'processing')
      .lt('updated_at', iso(d.now() - cutoffMs));
    if (kind === 'never-queued') query = query.or('processing_attempts.is.null,processing_attempts.eq.0');
    if (kind === 'queued') query = query.eq('processing_stage', 'queued' satisfies ProcessingStage);
    if (after) query = query.gt('updated_at', after);
    if (clientIds) query = query.in('client_id', clientIds);
    return query.order('updated_at', { ascending: true }).limit(limit);
  };
  // Still-'queued' rows past the grace are mostly live jobs waiting in a backlog (a big batch upload),
  // which could push a row whose job vanished beyond the limit: page through them (oldest first, at
  // most QUEUED_SCAN_PAGES pages) and keep only rows without a job of their run. Rows sharing the
  // page's last updated_at may be skipped this time; the next sweep sees them.
  const queuedWithoutJob = async () => {
    const found: InvoiceRow[] = [];
    let after: string | undefined;
    for (let page = 0; page < QUEUED_SCAN_PAGES && found.length < limit; page++) {
      const { data, error } = await candidates(ENQUEUE_GRACE_MS, 'queued', after);
      if (error) return { data: null, error };
      const rows = (data ?? []) as unknown as InvoiceRow[];
      if (rows.length === 0) break;
      const { data: jobRows, error: jobsErr } = await d.db
        .from(JOBS)
        .select('invoice_id, run_id')
        .in('invoice_id', rows.map((r) => r.id));
      if (jobsErr) return { data: null, error: jobsErr };
      const runs = new Map(((jobRows ?? []) as Pick<JobRow, 'invoice_id' | 'run_id'>[]).map((j) => [j.invoice_id, j.run_id]));
      for (const row of rows) if (runs.get(row.id) !== row.processing_run_id) found.push(row);
      if (rows.length < limit) break;
      after = rows[rows.length - 1].updated_at ?? undefined;
      if (!after) break;
    }
    return { data: found.slice(0, limit), error: null };
  };
  const lists = await Promise.all([
    candidates(ENQUEUE_GRACE_MS, 'never-queued'),
    queuedWithoutJob(),
    candidates(STALE_PROCESSING_MS, 'stale'),
  ]);
  const failedList = lists.find((l) => l.error);
  if (failedList) {
    console.error('[Queue] Stale sweep query failed:', failedList.error);
    return result;
  }
  const byId = new Map<string, InvoiceRow>();
  for (const row of lists.flatMap((l) => (l.data ?? []) as unknown as InvoiceRow[])) byId.set(row.id, row);
  const invoices = [...byId.values()];
  if (invoices.length === 0) return result;

  const { data: jobRows, error: jobsErr } = await d.db
    .from(JOBS)
    .select('invoice_id, run_id, locked_until, page_count')
    .in('invoice_id', invoices.map((i) => i.id));
  if (jobsErr) {
    console.error('[Queue] Stale sweep job query failed:', jobsErr);
    return result;
  }
  const jobs = new Map(((jobRows ?? []) as Pick<JobRow, 'invoice_id' | 'run_id' | 'locked_until' | 'page_count'>[]).map((j) => [j.invoice_id, j]));

  for (const invoice of invoices) {
    const job = jobs.get(invoice.id);
    const current = job && job.run_id === invoice.processing_run_id ? job : null;
    if (current) {
      const locked = current.locked_until ? Date.parse(current.locked_until) > d.now() : false;
      if (!locked && isRunTooOld(invoice.processing_started_at, d.now())) {
        await failRun(d, invoice.id, invoice.processing_run_id ?? null,
          stuckRunMessage('too_long', current.page_count ?? invoice.processing_progress?.pages_total), 'run older than MAX_RUN_MS (sweep)');
        result.failed.push(invoice.id);
      }
      continue;
    }
    const outcome = await resolveOrphanRun(d, invoice, 'sweep');
    if (outcome === 'queued') result.enqueued.push(invoice.id);
    else if (outcome === 'failed') result.failed.push(invoice.id);
  }
  if (result.failed.length > 0) console.warn(`[Queue] Marked ${result.failed.length} stuck invoices as error: ${result.failed.join(', ')}`);
  if (result.enqueued.length > 0) console.log(`[Queue] Queued ${result.enqueued.length} invoices without a job: ${result.enqueued.join(', ')}`);
  return result;
}

export interface DueJobs {
  /** Up to `limit` jobs a tick can take now, oldest activity first. */
  ids: string[];
  /** All jobs a tick can take now (lease free, no retry backoff pending). */
  total: number;
  /** Jobs not due yet that become due within DUE_SOON_MS (a short retry backoff, a lapsing lease). */
  soon?: number;
  /** Wait until the next job that isn't due yet becomes due, when that is within NEXT_DUE_HORIZON_MS. */
  nextDueInMs?: number | null;
}

/**
 * When a job can be taken next (epoch ms): after its lease and its retry backoff. A live tick renews
 * its lease to JOB_LEASE_MS ahead, so a running job is never "soon"; a lease that lapses (killed
 * tick) is.
 */
function jobReadyAt(job: { locked_until: string | null; retry_at?: string | null }): number {
  const lease = job.locked_until ? Date.parse(job.locked_until) : NaN;
  const retry = job.retry_at ? Date.parse(job.retry_at) : NaN;
  return Math.max(Number.isFinite(lease) ? lease : 0, Number.isFinite(retry) ? retry : 0);
}

/**
 * Jobs whose lease is free and whose retry backoff (if any) is over, oldest activity first (scheduled
 * worker), plus how many become due shortly and when the next one does (QA round 4: a job in a 5 s
 * backoff used to report due = 0, and the caller waited for the next minute).
 */
export async function dueJobs(limit = 5): Promise<DueJobs> {
  const d = await deps();
  const select = (cols: string) => d.db.from(JOBS).select(cols).order('updated_at', { ascending: true }).limit(200);
  let { data, error } = await select(transientColumnsUnsupported ? 'invoice_id, locked_until, updated_at' : 'invoice_id, locked_until, retry_at, updated_at');
  if (error && !transientColumnsUnsupported && isMissingColumn(error, TRANSIENT_COLUMNS)) {
    transientColumnsUnsupported = true;
    ({ data, error } = await select('invoice_id, locked_until, updated_at'));
  }
  if (error) {
    console.error('[Queue] Due jobs query failed:', error);
    return { ids: [], total: 0, soon: 0, nextDueInMs: null };
  }
  const now = d.now();
  const due: string[] = [];
  let soon = 0;
  let nextDueInMs: number | null = null;
  for (const j of (data ?? []) as unknown as { invoice_id: string; locked_until: string | null; retry_at?: string | null }[]) {
    const wait = jobReadyAt(j) - now;
    if (wait <= 0) {
      due.push(j.invoice_id);
      continue;
    }
    if (wait <= DUE_SOON_MS) soon++;
    if (wait <= NEXT_DUE_HORIZON_MS && (nextDueInMs === null || wait < nextDueInMs)) nextDueInMs = wait;
  }
  return { ids: due.slice(0, limit), total: due.length, soon, nextDueInMs };
}
