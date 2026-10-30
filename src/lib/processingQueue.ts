import { randomUUID } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import { isClientStorageFileUrl } from '@/lib/ingestHelpers';
import { isMockMode, supabaseUrl } from '@/lib/supabaseConfig';
import type { OcrWord } from '@/shared/types';
import type { SplitSuggestion } from '@/shared/documentSplit';
import { checkStoredBytes, mimeFromFileName } from '@/shared/uploadValidation';
import {
  EXTRACT_LOCK_MS,
  JOB_LOCK_MS,
  MAX_STAGE_ATTEMPTS,
  STALE_PROCESSING_MS,
  STUCK_RUN_MESSAGE,
  TICK_OCR_BUDGET_MS,
  TOO_MANY_ATTEMPTS_MESSAGE,
  UserFacingError,
  canProcess,
  isPermanentError,
  isStaleRun,
  nextOcrBatches,
  toUserErrorMessage,
  type JobStage,
  type ProcessingProgress,
  type ProcessingStage,
} from '@/shared/processing';
import type { PrecomputedOcr, PipelineRunOptions } from '@/agents/supervisor';
import type { BoundaryDetectionResult } from '@/agents/splitter';

/**
 * Durable processing queue (finding #6). Amplify cuts every HTTP response at ~28 s and may kill the
 * compute with it, so the pipeline never runs inside the request that asks for it:
 *
 *   enqueueProcessing()  - /process: status guard, new run token, a processing_jobs row. Returns at once.
 *   runProcessingTick()  - one bounded step: up to ~14 s of page-batched OCR, or boundary detection,
 *                          or extraction + validation + save. State lives in processing_jobs, so a
 *                          tick that is killed loses only its own step; the job lock expires and the
 *                          next tick retries it (MAX_STAGE_ATTEMPTS, then a Hebrew error).
 *   driveProcessing()    - ticks in a loop within a time budget (after() / webhooks, best-effort).
 *   sweepStaleProcessing() - 'processing' rows without progress for STALE_PROCESSING_MS -> error.
 *
 * Ticks are driven by the browser (/api/invoices/[id]/process/tick while an invoice is shown as
 * processing), by after() right after enqueueing, and by the scheduled worker
 * (/api/invoices/worker, PROCESSING_WORKER_SECRET), so progress never depends on one request living long.
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
  stage_attempts: number;
  lock_version: number;
  locked_until: string | null;
  last_error: string | null;
  updated_at?: string | null;
}

/** Everything a tick touches outside the DB, injectable for tests. */
export interface QueueDeps {
  db: SupabaseClient;
  now: () => number;
  fetchFile: (url: string) => Promise<Buffer>;
  ocrPdfPages: (file: Buffer, pdf: unknown, pages: number[]) => Promise<{ pageTexts: string[]; ocrWords: OcrWord[] }>;
  loadPdf: (file: Buffer) => Promise<{ getPageCount(): number } | null>;
  ocrImage: (file: Buffer) => Promise<{ rawOcrText: string; ocrWords: OcrWord[]; confidence: number; detectedLanguages: string[] }>;
  detect: (pageTexts: string[]) => Promise<BoundaryDetectionResult>;
  runPipeline: (invoiceId: string, fileUrl: string, mimeType: string, clientId: string, options: PipelineRunOptions) => Promise<void>;
  ocrBudgetMs: number;
}

async function defaultDeps(): Promise<QueueDeps> {
  const pre = await import('@/agents/preprocessor');
  const splitter = await import('@/agents/splitter');
  const supervisor = await import('@/agents/supervisor');
  return {
    db: supabase,
    now: () => Date.now(),
    fetchFile: pre.fetchInvoiceFile,
    ocrPdfPages: (file, pdf, pages) => pre.ocrPdfPages(file, pdf as Awaited<ReturnType<typeof pre.loadPdf>>, pages),
    loadPdf: pre.loadPdf,
    ocrImage: pre.ocrImage,
    detect: (pageTexts) => splitter.detectDocumentBoundaries(pageTexts),
    runPipeline: supervisor.runOrchestrationPipeline,
    ocrBudgetMs: TICK_OCR_BUDGET_MS,
  };
}

let depsOverride: Partial<QueueDeps> | null = null;
/** Test hook: replace some dependencies (null restores the defaults). */
export function setQueueDepsForTests(overrides: Partial<QueueDeps> | null): void {
  depsOverride = overrides;
}
async function deps(): Promise<QueueDeps> {
  const base = depsOverride?.db && depsOverride.fetchFile && depsOverride.runPipeline
    ? ({ now: () => Date.now(), ocrBudgetMs: TICK_OCR_BUDGET_MS } as QueueDeps)
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
  /** Explicit reopen of an approved invoice. */
  reopen?: boolean;
}

/** True while the invoice has a live run (a job of the current run that is not stuck). */
async function hasActiveRun(d: QueueDeps, invoice: InvoiceRow): Promise<boolean> {
  if (invoice.status !== 'processing' || !invoice.processing_run_id) return false;
  const job = await readJob(d.db, invoice.id);
  if (!job || job.run_id !== invoice.processing_run_id) return false;
  return !isStaleRun({ now: d.now(), startedAt: invoice.processing_started_at, lastActivityAt: job.updated_at, rowUpdatedAt: invoice.updated_at });
}

/**
 * Queues a (re)processing run. Refuses approved (without reopen), exported, rejected and returned
 * invoices and invoices with a live run (409). The claim is atomic: it is conditioned on the status
 * and run token just read, so two concurrent requests can't both start a run.
 */
export async function enqueueProcessing(invoiceId: string, options: EnqueueOptions = {}): Promise<EnqueueResult> {
  const d = await deps();
  const invoice = await readInvoice(d.db, invoiceId);
  if (!invoice) return { ok: false, httpStatus: 404, error: 'החשבונית לא נמצאה' };

  const decision = canProcess({ status: invoice.status, activeRun: await hasActiveRun(d, invoice), reopen: options.reopen === true });
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
  await d.db.from(JOBS).delete().eq('invoice_id', invoiceId);
}

async function setInvoiceProgress(d: QueueDeps, job: JobRow, stage: ProcessingStage, progress: ProcessingProgress): Promise<void> {
  await d.db.from('invoices').update({
    processing_stage: stage,
    processing_progress: progress,
    updated_at: iso(d.now()),
  }).eq('id', job.invoice_id).eq('processing_run_id', job.run_id);
}

/** Thrown when another tick took the job over (this tick's lock expired) or the run was replaced. */
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

// ── Tick ─────────────────────────────────────────────────────────────────────

export type TickState =
  | 'done'      // not processing any more (review / approved / error / ...)
  | 'pending'   // more work left; call again
  | 'busy'      // another tick holds the job
  | 'waiting'   // processing, but nothing queued yet (fresh upload before /process)
  | 'failed';   // this tick marked the invoice as error

export interface TickResult {
  state: TickState;
  stage?: ProcessingStage | null;
  progress?: ProcessingProgress | null;
}

/**
 * One bounded step of an invoice's run. Safe to call concurrently and repeatedly: the job lock
 * (optimistic lock_version + locked_until) lets one tick work at a time; the others answer 'busy'.
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
    return { state: 'busy', stage: job.stage, progress: { pages_done: job.pages_done, pages_total: job.page_count } };
  }

  if (isStaleRun({ now, startedAt: invoice.processing_started_at, lastActivityAt: job.updated_at, rowUpdatedAt: invoice.updated_at })) {
    console.warn(`[Queue] Run ${job.run_id} of invoice ${invoiceId} is stuck; marking as error.`);
    await failRun(d, invoiceId, job.run_id, STUCK_RUN_MESSAGE);
    return { state: 'failed' };
  }

  // Claim: only the tick that bumps the version it read gets the job
  const nextVersion = job.lock_version + 1;
  const { data: claimed, error: claimErr } = await d.db.from(JOBS).update({
    lock_version: nextVersion,
    locked_until: iso(now + (job.stage === 'extract' ? EXTRACT_LOCK_MS : JOB_LOCK_MS)),
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
    // Transient (rate limit, 5xx, network): free the lock, the next tick retries this stage
    await d.db.from(JOBS).update({
      locked_until: null,
      last_error: (err instanceof Error ? err.message : String(err)).slice(0, 2000),
      updated_at: iso(d.now()),
    }).eq('invoice_id', invoiceId).eq('lock_version', job.lock_version);
    return { state: 'pending', stage: job.stage };
  }
}

async function ocrStep(d: QueueDeps, job: JobRow): Promise<TickResult> {
  const started = d.now();
  const file = await d.fetchFile(job.file_url);
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

async function extractStep(d: QueueDeps, job: JobRow): Promise<TickResult> {
  const pageCount = job.page_count ?? Math.max(1, job.page_texts.length);
  const preOcr: PrecomputedOcr = {
    rawOcrText: job.page_texts.join('\n\n'),
    ocrMetadata: {
      pageCount,
      detectedLanguages: job.detected_languages && job.detected_languages.length > 0 ? job.detected_languages : ['he'],
      confidence: job.ocr_confidence ?? 0.95,
    },
    ocrOpCount: job.ocr_op_count,
    pageTexts: job.page_texts,
    ocrWords: job.ocr_words,
    splitSuggestion: job.split_suggestion,
    splitDetectionFailed: job.split_detection_failed,
    splitInputTokens: job.split_input_tokens,
    splitOutputTokens: job.split_output_tokens,
  };
  try {
    await d.runPipeline(job.invoice_id, job.file_url, job.mime_type, job.client_id, { runId: job.run_id, preOcr });
  } catch (err) {
    // runOrchestrationPipeline already stored a Hebrew error for this run; don't retry extraction
    console.error(`[Queue] Pipeline failed for invoice ${job.invoice_id}:`, err);
    await failRun(d, job.invoice_id, job.run_id, toUserErrorMessage(err));
    return { state: 'failed' };
  }
  await d.db.from(JOBS).delete().eq('invoice_id', job.invoice_id);
  return { state: 'done' };
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
 * Marks 'processing' invoices that made no progress for STALE_PROCESSING_MS as error (retry allowed).
 * `clientIds` limits the sweep (null = all, for the scheduled worker). Returns the ids it failed.
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
    const activity = job && job.run_id === invoice.processing_run_id ? job.updated_at : null;
    const locked = job?.locked_until ? Date.parse(job.locked_until) > d.now() : false;
    if (locked) continue;
    if (isStaleRun({ now: d.now(), startedAt: invoice.processing_started_at, lastActivityAt: activity, rowUpdatedAt: invoice.updated_at ?? invoice.created_at })) {
      await failRun(d, invoice.id, invoice.processing_run_id ?? null, STUCK_RUN_MESSAGE);
      failed.push(invoice.id);
    }
  }
  if (failed.length > 0) console.warn(`[Queue] Marked ${failed.length} stuck invoices as error: ${failed.join(', ')}`);
  return failed;
}

/** Jobs whose lock is free, oldest activity first (scheduled worker). */
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
