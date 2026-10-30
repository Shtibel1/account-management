import { randomUUID } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import { isClientStorageFileUrl } from '@/lib/ingestHelpers';
import { isMockMode, supabaseUrl } from '@/lib/supabaseConfig';
import type { ExtractedData, FewShotLookupState, OcrWord } from '@/shared/types';
import type { SplitSuggestion } from '@/shared/documentSplit';
import { checkStoredBytes, mimeFromFileName } from '@/shared/uploadValidation';
import {
  ENQUEUE_GRACE_MS,
  JOB_HEARTBEAT_MS,
  JOB_LEASE_MS,
  MAX_STAGE_ATTEMPTS,
  STALE_PROCESSING_MS,
  STUCK_RUN_MESSAGE,
  TICK_FINALIZE_BUDGET_MS,
  TICK_OCR_BUDGET_MS,
  TOO_MANY_ATTEMPTS_MESSAGE,
  UserFacingError,
  canProcess,
  isPermanentError,
  isRunTooOld,
  isStaleRun,
  nextOcrBatches,
  toUserErrorMessage,
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
  type ExtractState,
  type PageSpan,
} from '@/shared/extractionChunks';
import type { QueuedExtractionInput, QueuedExtractionOutcome } from '@/agents/supervisor';
import type { BoundaryDetectionResult } from '@/agents/splitter';

/**
 * Durable processing queue (finding #6, QA round 2). Amplify cuts every HTTP response at ~28 s and
 * may kill the compute with it, so the pipeline never runs inside the request that asks for it:
 *
 *   enqueueProcessing()  - /process: status guard, new run token, a processing_jobs row. Returns at once.
 *   runProcessingTick()  - one bounded step: up to ~14 s of page-batched OCR, or boundary detection,
 *                          or ONE extraction call over a few pages (long documents are extracted in
 *                          parts, src/shared/extractionChunks.ts), or validation + save. Every step's
 *                          result is stored in processing_jobs before the next starts, so a tick that
 *                          is killed loses only its own step. The job lease (JOB_LEASE_MS) is renewed
 *                          by a heartbeat while the step runs, so a dead tick frees the job within
 *                          seconds and the next tick redoes only that step (MAX_STAGE_ATTEMPTS
 *                          without progress, then a Hebrew error).
 *   driveProcessing()    - ticks in a loop within a time budget (after(), the worker, webhooks).
 *   sweepStaleProcessing() - 'processing' rows with nothing queued for STALE_PROCESSING_MS (or a run
 *                          older than MAX_RUN_MS) -> error. A queued job is resumed, not failed.
 *
 * Ticks are driven by the scheduled worker (/api/invoices/worker every minute, PROCESSING_WORKER_SECRET),
 * by after() right after enqueueing, and by the browser (/api/invoices/[id]/process/tick while an invoice
 * is shown as processing), so progress never depends on one request living long or on an open screen.
 */

const JOBS = 'processing_jobs';
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
  stage_attempts: number;
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
}

export interface ExtractCallResult {
  data: ExtractedData;
  inputTokens: number;
  outputTokens: number;
  fewShotInvoiceIds: string[];
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
  fetchFile: (url: string, clientId: string) => Promise<Buffer>;
  ocrPdfPages: (file: Buffer, pdf: unknown, pages: number[]) => Promise<{ pageTexts: string[]; ocrWords: OcrWord[] }>;
  loadPdf: (file: Buffer) => Promise<{ getPageCount(): number } | null>;
  ocrImage: (file: Buffer) => Promise<{ rawOcrText: string; ocrWords: OcrWord[]; confidence: number; detectedLanguages: string[] }>;
  detect: (pageTexts: string[]) => Promise<BoundaryDetectionResult>;
  loadFewShot: (invoiceId: string, clientId: string, ocrText: string) => Promise<FewShotLookupState>;
  /** One extraction LLM call. */
  extract: (input: ExtractCallInput) => Promise<ExtractCallResult>;
  /** Validation + save of the merged extraction (no LLM). */
  finalize: (input: FinalizeInput) => Promise<QueuedExtractionOutcome>;
  ocrBudgetMs: number;
  finalizeBudgetMs: number;
  /** Lease renewal interval while a step runs (0 = off, tests). */
  heartbeatMs: number;
}

async function defaultDeps(): Promise<QueueDeps> {
  const pre = await import('@/agents/preprocessor');
  const splitter = await import('@/agents/splitter');
  const supervisor = await import('@/agents/supervisor');
  const extraction = await import('@/agents/extraction');
  const fewshot = await import('@/lib/fewshot');
  const files = await import('@/lib/invoiceFiles');
  return {
    db: supabase,
    now: () => Date.now(),
    // file_url is a storage reference (not a link, QA #31): read it through a short-lived signed URL
    fetchFile: async (url, clientId) => {
      return pre.fetchInvoiceFile((await files.signedInvoiceFileUrl(url, clientId, files.PIPELINE_URL_TTL_SECONDS)) ?? url);
    },
    ocrPdfPages: (file, pdf, pages) => pre.ocrPdfPages(file, pdf as Awaited<ReturnType<typeof pre.loadPdf>>, pages),
    loadPdf: pre.loadPdf,
    ocrImage: pre.ocrImage,
    detect: (pageTexts) => splitter.detectDocumentBoundaries(pageTexts),
    loadFewShot: (invoiceId, clientId, ocrText) => fewshot.loadFewShotExamples(supabase, { invoiceId, tenantId: clientId, ocrText }),
    extract: async (input) => {
      const fileUrl = input.useVision
        ? (await files.signedInvoiceFileUrl(input.fileUrl, input.clientId, files.PIPELINE_URL_TTL_SECONDS)) ?? input.fileUrl
        : input.fileUrl;
      const r = await extraction.extractInvoiceData(input.text, fileUrl, input.mimeType, input.useVision, input.retryHint, input.fewShot, {
        hint: input.hint,
        allowLargeRetry: input.allowLargeRetry,
      });
      return { data: r.extractedData, inputTokens: r.inputTokens, outputTokens: r.outputTokens, fewShotInvoiceIds: r.fewShotInvoiceIds };
    },
    finalize: (input) => {
      const { tokens, ocrOpCount, ...rest } = input;
      const metrics = { ocrOpCount, inputTokens: tokens.input, outputTokens: tokens.output, estimatedCostUsd: 0 };
      metrics.estimatedCostUsd = supervisor.calculateEstimatedCost(metrics);
      return supervisor.finalizeQueuedExtraction({ ...rest, costMetrics: metrics });
    },
    ocrBudgetMs: TICK_OCR_BUDGET_MS,
    finalizeBudgetMs: TICK_FINALIZE_BUDGET_MS,
    heartbeatMs: JOB_HEARTBEAT_MS,
  };
}

let depsOverride: Partial<QueueDeps> | null = null;
/** Test hook: replace some dependencies (null restores the defaults). */
export function setQueueDepsForTests(overrides: Partial<QueueDeps> | null): void {
  depsOverride = overrides;
}
async function deps(): Promise<QueueDeps> {
  const base = depsOverride?.db && depsOverride.fetchFile && depsOverride.extract && depsOverride.finalize
    ? ({ now: () => Date.now(), ocrBudgetMs: TICK_OCR_BUDGET_MS, finalizeBudgetMs: TICK_FINALIZE_BUDGET_MS, heartbeatMs: 0 } as QueueDeps)
    : await defaultDeps();
  return { ...base, ...(depsOverride ?? {}) } as QueueDeps;
}

const iso = (ms: number) => new Date(ms).toISOString();

async function readInvoice(db: SupabaseClient, invoiceId: string): Promise<InvoiceRow | null> {
  const { data, error } = await db
    .from('invoices')
    .select('id, client_id, file_url, file_name, status, processing_run_id, processing_started_at, processing_attempts, updated_at, created_at')
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

// ── Enqueue ──────────────────────────────────────────────────────────────────

export type EnqueueResult =
  | { ok: true; runId: string }
  | { ok: false; httpStatus: 400 | 404 | 409 | 500; error: string };

export interface EnqueueOptions {
  mimeType?: unknown;
}

/**
 * True while the invoice has a live run: a job of the current run that is not stuck, or a run
 * claimed moments ago whose job row isn't written yet. The second case closes the window between
 * the claim and the job insert, in which a concurrent /process used to see "no job", take the run
 * over and start a second one (QA round 2, N11).
 */
async function hasActiveRun(d: QueueDeps, invoice: InvoiceRow): Promise<boolean> {
  if (invoice.status !== 'processing' || !invoice.processing_run_id) return false;
  const job = await readJob(d.db, invoice.id);
  if (job && job.run_id === invoice.processing_run_id) {
    return !isStaleRun({ now: d.now(), startedAt: invoice.processing_started_at, lastActivityAt: job.updated_at, rowUpdatedAt: invoice.updated_at });
  }
  const started = invoice.processing_started_at ? Date.parse(invoice.processing_started_at) : NaN;
  return Number.isFinite(started) && d.now() - started < ENQUEUE_GRACE_MS;
}

/**
 * Queues a (re)processing run. Refuses approved (reopen it first), exported, rejected and returned
 * invoices and invoices with a live run (409). The claim is conditioned on the status and run token
 * just read, and a freshly claimed run counts as live even before its job row exists, so of several
 * concurrent requests exactly one starts a run and the others get 409.
 */
export async function enqueueProcessing(invoiceId: string, options: EnqueueOptions = {}): Promise<EnqueueResult> {
  const d = await deps();
  const invoice = await readInvoice(d.db, invoiceId);
  if (!invoice) return { ok: false, httpStatus: 404, error: 'החשבונית לא נמצאה' };

  const decision = canProcess({ status: invoice.status, activeRun: await hasActiveRun(d, invoice) });
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
      processing_progress: { pages_done: 0, pages_total: null } satisfies ProcessingProgress,
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
    return { ok: false, httpStatus: 409, error: 'החשבונית כבר בעיבוד - יש להמתין לסיומו' };
  }

  await d.db.from(JOBS).delete().eq('invoice_id', invoiceId);
  const { error: jobErr } = await d.db.from(JOBS).insert({
    invoice_id: invoiceId,
    run_id: runId,
    client_id: invoice.client_id,
    file_url: invoice.file_url,
    mime_type: pickMimeType(options.mimeType, invoice.file_name),
    stage: 'ocr',
    pages_done: 0,
    page_texts: [],
    ocr_words: [],
    ocr_op_count: 0,
    split_detection_failed: false,
    split_input_tokens: 0,
    split_output_tokens: 0,
    stage_attempts: 0,
    lock_version: 0,
    locked_until: null,
    updated_at: iso(now),
  });
  if (jobErr) {
    console.error(`[Queue] Could not create the job of invoice ${invoiceId}:`, jobErr);
    await failRun(d, invoiceId, runId, 'לא ניתן היה להתחיל את העיבוד. יש לנסות שוב');
    return { ok: false, httpStatus: 500, error: 'לא ניתן היה להתחיל את העיבוד. יש לנסות שוב' };
  }
  console.log(`[Queue] Invoice ${invoiceId} queued (run ${runId}).`);
  return { ok: true, runId };
}

// ── Failing / finishing a run ────────────────────────────────────────────────

async function failRun(d: QueueDeps, invoiceId: string, runId: string | null, message: string): Promise<void> {
  let query = d.db.from('invoices').update({
    status: 'error',
    error_message: message,
    processing_stage: null,
    processing_progress: null,
    updated_at: iso(d.now()),
  }).eq('id', invoiceId).eq('status', 'processing');
  query = runId ? query.eq('processing_run_id', runId) : query;
  const { error } = await query;
  if (error) console.error(`[Queue] Could not mark invoice ${invoiceId} as failed:`, error);
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

/** Saves job fields; conditioned on the lock version this tick holds (throws LostJobLockError otherwise). */
async function saveJob(d: QueueDeps, job: JobRow, patch: Partial<JobRow>): Promise<void> {
  const { data, error } = await d.db.from(JOBS).update({ ...patch, updated_at: iso(d.now()) })
    .eq('invoice_id', job.invoice_id).eq('lock_version', job.lock_version).eq('run_id', job.run_id).select('invoice_id');
  if (error) throw new Error(`processing_jobs update failed: ${error.message}`);
  if (!Array.isArray(data) || data.length === 0) throw new LostJobLockError(job.invoice_id);
  Object.assign(job, patch);
}

/**
 * Renews the lease of the job this tick holds every `heartbeatMs` while its step runs. Only while
 * the lease is still held (lock_version unchanged, not released): a beat can never re-lock a job
 * the step already released. If the compute is frozen or killed, the beats stop and the lease runs
 * out after JOB_LEASE_MS, so the next tick takes over quickly.
 */
function startHeartbeat(d: QueueDeps, job: JobRow): () => void {
  if (!d.heartbeatMs || d.heartbeatMs <= 0) return () => {};
  const lockVersion = job.lock_version;
  const timer = setInterval(() => {
    const now = d.now();
    try {
      void Promise.resolve(
        d.db.from(JOBS)
          .update({ locked_until: iso(now + JOB_LEASE_MS), updated_at: iso(now) })
          .eq('invoice_id', job.invoice_id)
          .eq('lock_version', lockVersion)
          .not('locked_until', 'is', null)
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
  | 'busy'      // another tick holds the job (or this tick's step goes on in the background)
  | 'waiting'   // processing, but nothing queued yet (fresh upload before /process)
  | 'failed';   // this tick marked the invoice as error

export interface TickResult {
  state: TickState;
  stage?: ProcessingStage | null;
  progress?: ProcessingProgress | null;
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

/**
 * One bounded step of an invoice's run. Safe to call concurrently and repeatedly: the job lease
 * (optimistic lock_version + locked_until, renewed by a heartbeat) lets one tick work at a time;
 * the others answer 'busy'.
 */
export async function runProcessingTick(invoiceId: string): Promise<TickResult> {
  const d = await deps();
  const invoice = await readInvoice(d.db, invoiceId);
  if (!invoice) return { state: 'done' };
  let job = await readJob(d.db, invoiceId);

  if (invoice.status !== 'processing') {
    if (job) await d.db.from(JOBS).delete().eq('invoice_id', invoiceId);
    return { state: 'done' };
  }

  if (!job || job.run_id !== invoice.processing_run_id) {
    if (job) await d.db.from(JOBS).delete().eq('invoice_id', invoiceId); // left over from a superseded run
    // A row stuck in 'processing' with no queued work (e.g. from before the queue existed, or an
    // upload whose /process call never arrived): give up after STALE_PROCESSING_MS so it can be retried.
    if (isStaleRun({ now: d.now(), startedAt: invoice.processing_started_at, lastActivityAt: null, rowUpdatedAt: invoice.updated_at ?? invoice.created_at })) {
      await failRun(d, invoiceId, invoice.processing_run_id ?? null, STUCK_RUN_MESSAGE);
      return { state: 'failed' };
    }
    return { state: 'waiting', stage: 'queued' };
  }

  const now = d.now();
  const lockedUntil = job.locked_until ? Date.parse(job.locked_until) : null;
  if (lockedUntil !== null && lockedUntil > now) {
    return { state: 'busy', stage: job.stage, progress: jobProgress(job) };
  }

  // A queued job whose lease is free is resumed, however long nobody drove it (N4: "nobody ticked
  // it" is not a failure). Killed ticks are bounded by MAX_STAGE_ATTEMPTS, endless runs by MAX_RUN_MS.
  if (isRunTooOld(invoice.processing_started_at, now)) {
    console.warn(`[Queue] Run ${job.run_id} of invoice ${invoiceId} ran too long; marking as error.`);
    await failRun(d, invoiceId, job.run_id, STUCK_RUN_MESSAGE);
    return { state: 'failed' };
  }

  // Claim: only the tick that bumps the version it read gets the job
  const nextVersion = job.lock_version + 1;
  const { data: claimed, error: claimErr } = await d.db.from(JOBS).update({
    lock_version: nextVersion,
    locked_until: iso(now + JOB_LEASE_MS),
    stage_attempts: job.stage_attempts + 1,
    updated_at: iso(now),
  }).eq('invoice_id', invoiceId).eq('lock_version', job.lock_version).select('invoice_id');
  if (claimErr) throw new Error(`processing_jobs claim failed: ${claimErr.message}`);
  if (!Array.isArray(claimed) || claimed.length === 0) return { state: 'busy', stage: job.stage };
  job = { ...job, lock_version: nextVersion, stage_attempts: job.stage_attempts + 1 };

  if (job.stage_attempts > MAX_STAGE_ATTEMPTS) {
    console.error(`[Queue] Stage ${job.stage} of invoice ${invoiceId} failed ${MAX_STAGE_ATTEMPTS} times (last: ${job.last_error ?? 'killed / timed out'}).`);
    await failRun(d, invoiceId, job.run_id, job.last_error ? toUserErrorMessage(job.last_error) : TOO_MANY_ATTEMPTS_MESSAGE);
    return { state: 'failed' };
  }

  const stopHeartbeat = startHeartbeat(d, job);
  try {
    if (job.stage === 'ocr') return await ocrStep(d, job);
    if (job.stage === 'detect') return await detectStep(d, job);
    return await extractStep(d, job);
  } catch (err) {
    if (err instanceof LostJobLockError) {
      // Another tick (or a new run) owns the job now: leave it alone
      console.warn(`[Queue] ${err.message}; stopping this tick.`);
      return { state: 'busy', stage: job.stage };
    }
    console.error(`[Queue] Tick failed for invoice ${invoiceId} (stage ${job.stage}, attempt ${job.stage_attempts}):`, err);
    if (isPermanentError(err) || job.stage_attempts >= MAX_STAGE_ATTEMPTS) {
      await failRun(d, invoiceId, job.run_id, toUserErrorMessage(err));
      return { state: 'failed' };
    }
    // Transient (rate limit, 5xx, network): free the lease, the next tick retries this step only
    // (the results of earlier steps are already stored in the job)
    await d.db.from(JOBS).update({
      locked_until: null,
      last_error: (err instanceof Error ? err.message : String(err)).slice(0, 2000),
      updated_at: iso(d.now()),
    }).eq('invoice_id', invoiceId).eq('lock_version', job.lock_version);
    return { state: 'pending', stage: job.stage };
  } finally {
    stopHeartbeat();
  }
}

async function ocrStep(d: QueueDeps, job: JobRow): Promise<TickResult> {
  const started = d.now();
  const file = await d.fetchFile(job.file_url, job.client_id);
  // Reject what Vision can't read before calling it (empty, oversized, not a PDF / image)
  const check = checkStoredBytes(file);
  if (!check.ok) throw new UserFacingError(check.error);

  if (check.mimeType !== 'application/pdf') {
    const img = await d.ocrImage(file);
    await saveJob(d, job, {
      page_count: 1, pages_done: 1, page_texts: [img.rawOcrText], ocr_words: img.ocrWords,
      ocr_confidence: img.confidence, detected_languages: img.detectedLanguages, ocr_op_count: 1,
      mime_type: check.mimeType, stage: 'extract', stage_attempts: 0, locked_until: null, last_error: null,
    });
    await setInvoiceProgress(d, job, 'extract', { pages_done: 1, pages_total: 1 });
    return { state: 'pending', stage: 'extract', progress: { pages_done: 1, pages_total: 1 } };
  }

  const pdf = await d.loadPdf(file);
  const pageCount = pdf ? pdf.getPageCount() : 1;
  if (pageCount < 1) throw new UserFacingError('קובץ ה-PDF אינו מכיל עמודים');
  if (job.page_count !== pageCount) {
    await saveJob(d, job, { page_count: pageCount, mime_type: 'application/pdf' });
  }
  await setInvoiceProgress(d, job, 'ocr', { pages_done: job.pages_done, pages_total: pageCount });

  // OCR a few pages at a time, saving after each round. A new round starts only if it is expected
  // to end within the tick's budget (estimated from the previous round), so a tick stays short.
  // At least one round per tick, so a slow download can never stall the run.
  let lastRoundMs = 0;
  let rounds = 0;
  while (job.pages_done < pageCount && (rounds === 0 || d.now() - started + lastRoundMs < d.ocrBudgetMs)) {
    rounds++;
    const roundStarted = d.now();
    const batches = nextOcrBatches(job.pages_done, pageCount);
    const results = await Promise.all(batches.map((pages) => d.ocrPdfPages(file, pdf, pages)));
    const done = batches.reduce((n, b) => n + b.length, 0);
    await saveJob(d, job, {
      pages_done: job.pages_done + done,
      page_texts: [...job.page_texts, ...results.flatMap((r) => r.pageTexts)],
      ocr_words: [...job.ocr_words, ...results.flatMap((r) => r.ocrWords)],
      ocr_op_count: job.ocr_op_count + batches.length,
      // progress resets the attempt counter: only a stage that makes no progress fails the run
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

async function detectStep(d: QueueDeps, job: JobRow): Promise<TickResult> {
  const detection = await d.detect(job.page_texts);
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
 * Extraction in resumable steps (QA round 2, N5 / N14 / N22). Each tick makes at most ONE LLM call
 * (one page chunk, or the math retry) and stores its result in processing_jobs.extract_state before
 * it returns, so no request has to outlive the Amplify limit and a killed tick re-pays only for
 * its own call. When every chunk is in, the merged result is validated and saved (no LLM), in the
 * same tick if there is time left, else in the next.
 */
async function extractStep(d: QueueDeps, job: JobRow): Promise<TickResult> {
  const started = d.now();
  const pageCount = job.page_count ?? Math.max(1, job.page_texts.length);
  let state: ExtractState = isValidExtractState(job.extract_state, pageCount)
    ? (job.extract_state as ExtractState)
    : initialExtractState(job.page_texts, pageCount, job.split_suggestion);
  const rangeText = chunkText(job.page_texts, state.range);
  let llmCalls = 0;

  /** Stores the state; false when it can't be stored (old DB): the step then goes on in memory. */
  const persist = async (next: ExtractState): Promise<boolean> => {
    state = next;
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
  /** Ends this tick after its LLM call; the next tick continues from the stored state. */
  const yieldTick = async (): Promise<TickResult> => {
    await saveJob(d, job, { locked_until: null });
    const progress = jobProgress(job);
    await setInvoiceProgress(d, job, 'extract', progress);
    return { state: 'pending', stage: 'extract', progress };
  };
  const canYield = () => !extractStateUnsupported;

  for (;;) {
    if (state.phase === 'chunks') {
      const index = nextChunkIndex(state);
      if (index === null) {
        state = { ...state, phase: 'finalize' };
        continue;
      }
      if (llmCalls > 0 && canYield()) return yieldTick();
      const fewShot = state.few_shot ?? (await d.loadFewShot(job.invoice_id, job.client_id, rangeText));
      const span = state.chunks[index];
      const r = await d.extract({
        invoiceId: job.invoice_id,
        clientId: job.client_id,
        text: chunkText(job.page_texts, span),
        fileUrl: job.file_url,
        mimeType: job.mime_type,
        useVision: false,
        retryHint: false,
        hint: chunkHint(state, index),
        allowLargeRetry: state.chunks.length === 1,
        fewShot,
      });
      llmCalls++;
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
      if (llmCalls > 0 && canYield()) return yieldTick();
      // The sums didn't match: read the part with the amounts again, more carefully (once).
      // A one-page image is sent as the image itself, as the pipeline always did.
      const index = amountsChunkIndex(state);
      const previous = state.results[index];
      const r = await d.extract({
        invoiceId: job.invoice_id,
        clientId: job.client_id,
        text: chunkText(job.page_texts, state.chunks[index]),
        fileUrl: job.file_url,
        mimeType: job.mime_type,
        useVision: job.mime_type.startsWith('image/') && state.chunks.length === 1,
        retryHint: true,
        hint: chunkHint(state, index),
        allowLargeRetry: state.chunks.length === 1,
        fewShot: state.few_shot ?? { examples: [], supplierVatId: null },
      });
      llmCalls++;
      const results = [...state.results];
      results[index] = {
        data: r.data,
        input_tokens: (previous?.input_tokens ?? 0) + r.inputTokens,
        output_tokens: (previous?.output_tokens ?? 0) + r.outputTokens,
      };
      await persist({ ...state, results, retry_count: state.retry_count + 1, phase: 'finalize' });
      continue;
    }

    // finalize: validation + save, no LLM. After a long LLM call it gets a tick of its own.
    if (llmCalls > 0 && d.now() - started > d.finalizeBudgetMs && canYield()) return yieldTick();
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
      splitSuggestion: job.split_suggestion,
      splitDetectionFailed: job.split_detection_failed,
      fewShotExampleIds: state.few_shot_ids,
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

/** Runs ticks back to back until the run ends, another tick holds it, or the budget is used. */
export async function driveProcessing(invoiceId: string, budgetMs: number): Promise<TickResult> {
  const started = Date.now();
  let last: TickResult = { state: 'pending' };
  while (Date.now() - started < budgetMs) {
    last = await runProcessingTick(invoiceId);
    if (last.state !== 'pending') break;
  }
  return last;
}

/**
 * Marks 'processing' invoices as error (retry allowed) when nothing is queued for them and they made
 * no progress for STALE_PROCESSING_MS, or their run is older than MAX_RUN_MS. A run with a queued
 * job is left to the ticks, which resume it. `clientIds` limits the sweep (null = all, for the
 * scheduled worker). Returns the ids it failed.
 */
export async function sweepStaleProcessing(clientIds: string[] | null = null, limit = 50): Promise<string[]> {
  const d = await deps();
  const cutoff = iso(d.now() - STALE_PROCESSING_MS);
  let query = d.db
    .from('invoices')
    .select('id, client_id, file_url, file_name, status, processing_run_id, processing_started_at, processing_attempts, updated_at, created_at')
    .eq('status', 'processing')
    .lt('updated_at', cutoff);
  if (clientIds) {
    if (clientIds.length === 0) return [];
    query = query.in('client_id', clientIds);
  }
  const { data, error } = await query.limit(limit);
  if (error) {
    console.error('[Queue] Stale sweep query failed:', error);
    return [];
  }
  const failed: string[] = [];
  for (const invoice of (data ?? []) as InvoiceRow[]) {
    const job = await readJob(d.db, invoice.id);
    const current = job && job.run_id === invoice.processing_run_id ? job : null;
    const locked = current?.locked_until ? Date.parse(current.locked_until) > d.now() : false;
    if (locked) continue;
    const stuck = current
      ? isRunTooOld(invoice.processing_started_at, d.now())
      : isStaleRun({ now: d.now(), startedAt: invoice.processing_started_at, lastActivityAt: null, rowUpdatedAt: invoice.updated_at ?? invoice.created_at });
    if (stuck) {
      await failRun(d, invoice.id, invoice.processing_run_id ?? null, STUCK_RUN_MESSAGE);
      failed.push(invoice.id);
    }
  }
  if (failed.length > 0) console.warn(`[Queue] Marked ${failed.length} stuck invoices as error: ${failed.join(', ')}`);
  return failed;
}

/** Jobs whose lease is free, oldest activity first (scheduled worker). */
export async function dueJobIds(limit = 5): Promise<string[]> {
  const d = await deps();
  const { data, error } = await d.db.from(JOBS).select('invoice_id, locked_until, updated_at').order('updated_at', { ascending: true }).limit(100);
  if (error) {
    console.error('[Queue] Due jobs query failed:', error);
    return [];
  }
  const now = d.now();
  return ((data ?? []) as { invoice_id: string; locked_until: string | null }[])
    .filter((j) => !j.locked_until || Date.parse(j.locked_until) <= now)
    .slice(0, limit)
    .map((j) => j.invoice_id);
}
