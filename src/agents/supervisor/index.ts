import { StateGraph, END, MemorySaver } from '@langchain/langgraph';
import type { PipelineState, TenantRules, ExtractedData, OcrWord, OcrMetadata, BboxMap, FieldBbox, ValidationResult, SupplierRuleTrace, CostMetrics } from '@/shared/types';
import { preprocessInvoice } from '../preprocessor';
import { extractInvoiceData } from '../extraction';
import { validateInvoice } from '../validation';
import { approvalNode } from '../approval';
import { detectDocumentBoundaries } from '../splitter';
import { isMultiDocument, shouldAutoSplit, usableSuggestion, type SplitSuggestion } from '@/shared/documentSplit';
import { supabase } from '@/lib/supabase';
import { withSupplierRule } from '@/shared/supplierRules';
import { loadFewShotExamples, saveExtractionContext } from '@/lib/fewshot';
import { saveInvoiceFileHash, sha256Hex } from '@/lib/fileHash';
import { linkResubmission, linkReturnedToResubmission, planResubmissionLink, unlinkReturnedFromResubmission } from '@/lib/returns';
import { computeConfidence } from '@/shared/confidence';
import { PDFDocument } from 'pdf-lib';
import { PIPELINE_URL_TTL_SECONDS, signedInvoiceFileUrl, signObjectPath, storedFileUrlFor } from '@/lib/invoiceFiles';
import { toUserErrorMessage } from '@/shared/processing';

function parseNumber(text: string): number | null {
  const clean = text.replace(/[^0-9.]/g, '');
  const val = parseFloat(clean);
  return isNaN(val) ? null : val;
}

function parseDateParts(text: string): { day: number; month: number; year: number } | null {
  const clean = text.replace(/[^0-9/.-]/g, '');
  const parts = clean.split(/[/.-]/).map((p) => parseInt(p, 10)).filter((p) => !isNaN(p));
  if (parts.length === 3) {
    if (parts[0] > 1000) {
      return { year: parts[0], month: parts[1], day: parts[2] };
    }
    let year = parts[2];
    if (year < 100) year += 2000;
    return { day: parts[0], month: parts[1], year };
  }
  return null;
}

function datesMatch(a: string, b: string): boolean {
  const da = parseDateParts(a);
  const db = parseDateParts(b);
  if (da && db) {
    return da.day === db.day && da.month === db.month && da.year === db.year;
  }
  return false;
}

function numbersMatch(a: string, b: string): boolean {
  const na = parseNumber(a);
  const nb = parseNumber(b);
  if (na !== null && nb !== null) {
    return na === nb;
  }
  return false;
}

function cleanTextForMatching(text: string): string {
  return text
    .replace(/[^a-zA-Z0-9א-ת]/g, '')
    .trim();
}

function findExactBbox(value: string | number | null, ocrWords: OcrWord[]): FieldBbox | undefined {
  if (value == null) return undefined;
  const targetStr = String(value).trim();
  const cleanedTarget = cleanTextForMatching(targetStr);
  if (!cleanedTarget) return undefined;

  // 1. First search for exact or partial matches in single words (including date/numeric value equivalence)
  const singleMatches = ocrWords.filter(
    (w) => {
      const cleanWord = cleanTextForMatching(w.text);
      
      // Prevent numeric substring matches (e.g. "97611" matching "039761111")
      const isTargetNumeric = /^\d+$/.test(cleanedTarget);
      const isWordNumeric = /^\d+$/.test(cleanWord);
      
      let isMatch = false;
      if (isTargetNumeric && isWordNumeric) {
        isMatch = cleanWord === cleanedTarget;
      } else {
        isMatch = cleanedTarget.length <= 2
          ? cleanWord === cleanedTarget
          : cleanWord.includes(cleanedTarget);
      }

      if (isMatch) {
        return true;
      }
      if (numbersMatch(w.text, targetStr)) {
        return true;
      }
      if (datesMatch(w.text, targetStr)) {
        return true;
      }
      return false;
    }
  );

  if (singleMatches.length > 0) {
    // Return only the first match to avoid merging multiple separate occurrences of a single word into a giant box
    const firstMatch = singleMatches[0];
    return {
      x1: firstMatch.bbox.x1,
      y1: firstMatch.bbox.y1,
      x2: firstMatch.bbox.x2,
      y2: firstMatch.bbox.y2,
      page: firstMatch.page,
    };
  }

  // 2. If it's a multi-word value, search for phrase sequence matches (order-independent window to handle RTL/LTR direction swapping)
  const targetTokens = targetStr.split(/\s+/).map(cleanTextForMatching).filter(Boolean);
  if (targetTokens.length > 1) {
    for (let i = 0; i <= ocrWords.length - targetTokens.length; i++) {
      let matchesAll = true;
      const windowTokens = ocrWords.slice(i, i + targetTokens.length).map((w) => cleanTextForMatching(w.text));
      for (const t of targetTokens) {
        if (!windowTokens.some((wt) => wt.includes(t) || t.includes(wt))) {
          matchesAll = false;
          break;
        }
      }
      if (matchesAll) {
        const matchedSequence = ocrWords.slice(i, i + targetTokens.length);
        const xs = matchedSequence.flatMap((m) => [m.bbox.x1, m.bbox.x2]);
        const ys = matchedSequence.flatMap((m) => [m.bbox.y1, m.bbox.y2]);
        return {
          x1: Math.min(...xs),
          y1: Math.min(...ys),
          x2: Math.max(...xs),
          y2: Math.max(...ys),
          page: matchedSequence[0].page,
        };
      }
    }
  }

  return undefined;
}

export function matchBboxesWithOcr(
  extractedData: ExtractedData,
  ocrWords: OcrWord[] | undefined
): BboxMap {
  const bboxes: BboxMap = { ...extractedData.bboxes };
  if (!ocrWords || ocrWords.length === 0) return bboxes;

  const fields: (keyof BboxMap)[] = [
    'supplier_name',
    'supplier_vat_id',
    'invoice_number',
    'invoice_date',
    'amount_before_vat',
    'vat_amount',
    'total_amount',
    'expense_category',
    'allocation_number',
  ];
  // The model's own boxes for these fields are guesses (often a default region); with OCR words
  // available, a box that can't be snapped to the printed value is dropped rather than drawn in
  // the wrong place.
  const dropUnmatched = new Set<keyof BboxMap>(['allocation_number']);

  for (const field of fields) {
    const val = extractedData[field];
    if (val != null) {
      const match = findExactBbox(val, ocrWords);
      if (match) {
        bboxes[field] = match;
      } else if (dropUnmatched.has(field)) {
        delete bboxes[field];
      }
    } else if (dropUnmatched.has(field)) {
      delete bboxes[field];
    }
  }

  return bboxes;
}

async function splitPdfBuffer(
  fileBuffer: Buffer,
  startPage: number,
  endPage: number
): Promise<Buffer> {
  const originalDoc = await PDFDocument.load(fileBuffer);
  const newDoc = await PDFDocument.create();
  
  const pagesToCopy = [];
  for (let i = startPage - 1; i <= endPage - 1; i++) {
    pagesToCopy.push(i);
  }
  
  const copiedPages = await newDoc.copyPages(originalDoc, pagesToCopy);
  copiedPages.forEach((page) => newDoc.addPage(page));
  
  const pdfBytes = await newDoc.save();
  return Buffer.from(pdfBytes);
}

function sanitizeStorageFilename(fileName: string): string {
  const lastDot = fileName.lastIndexOf('.');
  const ext = lastDot !== -1 ? fileName.substring(lastDot) : '';
  const nameWithoutExt = lastDot !== -1 ? fileName.substring(0, lastDot) : fileName;
  
  let sanitized = nameWithoutExt
    .replace(/[^a-zA-Z0-9-.]/g, '_')
    .replace(/__+/g, '_')
    .replace(/--+/g, '-')
    .replace(/^[_-]+|[_-]+$/g, '');
    
  if (!sanitized) {
    sanitized = Buffer.from(nameWithoutExt).toString('hex').substring(0, 16);
  }
  
  return `${sanitized}${ext}`;
}


// Confidence scoring lives in shared/confidence.ts (also used by the approval node)
export { computeConfidence };

/**
 * Validation rules of a client. There is no per-client rules column: the old lookup of
 * clients.rules (a column that never existed) answered 400 on every finalize and fell back to these
 * defaults anyway (QA round 4), so every client gets the defaults without a DB round trip.
 */
export async function getTenantRules(): Promise<TenantRules> {
  const defaultRules: TenantRules = {
    maxAmountForAutoApprove: 1000,
    requireVatId: true,
    requireInvoiceDate: true,
    requireExpenseCategory: true,
    allowedExpenseCategories: [
      'ציוד משרדי',
      'שכ"ד',
      'תקשורת',
      'שיווק ופרסום',
      'נסיעות',
      'אחזקה',
      'שירותים מקצועיים',
      'חשמל ומים',
      'אחר'
    ],
    duplicateInvoiceCheck: true,
  };

  return defaultRules;
}

// Calculate token and OCR costs for billing
export function calculateEstimatedCost(metrics: {
  ocrOpCount: number;
  inputTokens: number;
  outputTokens: number;
}): number {
  const ocrCost = metrics.ocrOpCount * 0.0015; // $1.50 per 1000 pages ($0.0015 each)
  const inputCost = (metrics.inputTokens / 1_000_000) * 3.00; // Claude 4.5 Sonnet: $3.00/MTok
  const outputCost = (metrics.outputTokens / 1_000_000) * 15.00; // Claude 4.5 Sonnet: $15.00/MTok
  return Math.round((ocrCost + inputCost + outputCost) * 10000) / 10000;
}

/** OCR + boundary detection done earlier by the processing queue (src/lib/processingQueue.ts). */
export interface PrecomputedOcr {
  rawOcrText: string;
  ocrMetadata: OcrMetadata;
  ocrOpCount: number;
  pageTexts: string[];
  ocrWords: OcrWord[];
  splitSuggestion: SplitSuggestion | null;
  splitDetectionFailed: boolean;
  splitInputTokens: number;
  splitOutputTokens: number;
}

export interface PipelineRunOptions {
  /** invoices.processing_run_id of this run: writes are skipped once another run took over. */
  runId?: string | null;
  /** Skip OCR / detection and use these results (queue ticks did them already). */
  preOcr?: PrecomputedOcr | null;
}

export type PipelineRunState = PipelineState & { runId?: string | null; splitDetectionFailed?: boolean };

export const SPLIT_DETECTION_FAILED_WARNING = 'לא ניתן היה לבדוק אוטומטית אם הקובץ מכיל כמה מסמכים - יש לבדוק ידנית ולפצל במידת הצורך';

/**
 * Writes a run's result to its invoice, but only while this run still owns the row
 * (processing_run_id unchanged: no re-process, manual split or sweeper since it started).
 * An invoice a human already reviewed (reviewed_at) keeps its validated_data and goes back to
 * 'review' - the new AI output never replaces approved values or auto-approves it.
 * Returns false when the write was skipped.
 */
export async function writeRunResult(
  state: PipelineRunState,
  update: Record<string, unknown>
): Promise<boolean> {
  const runId = state.runId ?? null;
  const { data: row, error: readErr } = await supabase
    .from('invoices')
    .select('id, reviewed_at, processing_run_id')
    .eq('id', state.invoiceId)
    .single();
  if (readErr || !row) {
    console.error(`[Supervisor] Could not read invoice ${state.invoiceId} before saving:`, readErr);
    return false;
  }
  const current = row as { reviewed_at?: string | null; processing_run_id?: string | null };
  if (runId && current.processing_run_id !== runId) {
    console.warn(`[Supervisor] Run ${runId} of invoice ${state.invoiceId} was superseded (now ${current.processing_run_id ?? 'none'}); result discarded.`);
    return false;
  }

  const payload: Record<string, unknown> = {
    ...update,
    processing_stage: null,
    processing_progress: null,
    updated_at: new Date().toISOString(),
  };
  if (current.reviewed_at) {
    delete payload.validated_data;
    if (payload.status === 'approved') payload.status = 'review';
  }

  let query = supabase.from('invoices').update(payload).eq('id', state.invoiceId);
  if (runId) query = query.eq('processing_run_id', runId);
  const { data: written, error } = await query.select('id');
  if (error) {
    console.error(`[Supervisor] Failed to save result of invoice ${state.invoiceId}:`, error);
    return false;
  }
  // Superseded between the read above and this write (re-process / split / sweeper): nothing saved
  if (Array.isArray(written) && written.length === 0) {
    console.warn(`[Supervisor] Run ${runId} of invoice ${state.invoiceId} was superseded while saving; result discarded.`);
    return false;
  }
  return true;
}

// Persist the OCR text (future few-shot input) and which examples were used, best-effort
async function saveRunContext(state: PipelineState): Promise<void> {
  await saveExtractionContext(supabase, state.invoiceId, {
    ocrText: state.rawOcrText,
    fewShotExampleIds: state.fewShotExampleIds ?? null,
  });
}

export interface RunValidationInput {
  invoiceId: string;
  tenantId: string;
  extractedData: ExtractedData;
  tenantRules: TenantRules;
  rawOcrText: string | null;
  splitSuggestion: SplitSuggestion | null;
  /** Page count of the file (a split suggestion for another page count is stale). */
  pageCount: number | null;
  splitDetectionFailed: boolean;
  /** OCR words of the file (lets validation check values against the document). */
  ocrWords?: OcrWord[];
}

export interface RunValidationOutput {
  extractedData: ExtractedData;
  validationResult: ValidationResult;
  supplierRule: SupplierRuleTrace | null;
  error: string | null;
}

/** Deterministic validation of a run's extraction, plus the multi-document review rules. */
export async function applyRunValidation(input: RunValidationInput): Promise<RunValidationOutput> {
  const { data: validated, validationResult, supplierRule } = await validateInvoice(
    input.invoiceId,
    input.tenantId,
    input.extractedData,
    input.tenantRules,
    { ocrText: input.rawOcrText, ocrWords: input.ocrWords }
  );
  // A file that holds several invoices must not be auto-approved as one: force review and
  // store the suggestion so the review screen can pre-fill the split dialog.
  // Only a suggestion that still matches this file's page count (stale ones are dropped)
  const splitSuggestion = usableSuggestion(input.splitSuggestion, input.pageCount);
  if (splitSuggestion) {
    const warning = `נראה שהקובץ מכיל ${splitSuggestion.documents.length} מסמכים נפרדים — מומלץ לפצל לפני אישור`;
    if (!validationResult.warnings.includes(warning)) validationResult.warnings.push(warning);
    validationResult.requires_manual_review = true;
    // An opted-in supplier's invoice that passed every check still needs review here
    if (validationResult.auto_approved) {
      validationResult.auto_approved = false;
      validationResult.auto_approve_blockers = [
        ...(validationResult.auto_approve_blockers ?? []),
        'הקובץ נראה כמכיל כמה מסמכים — יש לפצל לפני אישור',
      ];
    }
    validated.validation_flags = validationResult;
  }
  validated.split_suggestion = splitSuggestion;
  // Detection was needed but failed (e.g. the model's answer was cut off): the file may hold
  // several invoices, so a reviewer has to look before it can be approved.
  if (!splitSuggestion && input.splitDetectionFailed) {
    if (!validationResult.warnings.includes(SPLIT_DETECTION_FAILED_WARNING)) {
      validationResult.warnings.push(SPLIT_DETECTION_FAILED_WARNING);
    }
    validationResult.requires_manual_review = true;
    if (validationResult.auto_approved) {
      validationResult.auto_approved = false;
      validationResult.auto_approve_blockers = [
        ...(validationResult.auto_approve_blockers ?? []),
        'לא ניתן היה לוודא שהקובץ מכיל מסמך אחד בלבד',
      ];
    }
    validated.validation_flags = validationResult;
  }

  const errorMsg = validationResult.not_an_invoice ? 'המסמך לא זוהה כחשבונית' : null;
  return { extractedData: validated, validationResult, supplierRule, error: errorMsg };
}

export type ValidationRoute = 'retry' | 'save_review' | 'save_success' | 'save_error';

/** Where a run goes after validation: one math retry, then review / auto-approve / error. */
export function routeAfterValidation(result: ValidationResult | null | undefined, retryCount: number): ValidationRoute {
  if (!result) return 'save_error';
  // Route to exception/error if not an invoice
  if (result.not_an_invoice) return 'save_error';
  // Mathematical retry loop
  if (!result.math_ok && retryCount < 1) return 'retry';
  // HITL vs Auto-approve route
  if (result.requires_manual_review) return 'save_review';
  return 'save_success';
}

/**
 * Saves a run's outcome ('review' / 'approved' / 'error'), only while the run still owns the row.
 * A corrected document for an invoice the accountant returned is linked in the same write as its
 * status (QA round 2, N20): the returned invoice is pointed at it first, then the document is saved
 * with resubmission_of, the return warning and the duplicate flag dismissed - so nobody reading it
 * once it left 'processing' sees it unlinked. If that save doesn't happen (superseded run), the
 * returned invoice is unlinked again. Returns true when saved.
 */
export async function saveRunOutcome(state: PipelineState, kind: 'review' | 'approved' | 'error'): Promise<boolean> {
  if (kind === 'error') {
    console.error(`[Supervisor] ❌ Saving state: ERROR (Total Cost: $${state.costMetrics.estimatedCostUsd}). Details: ${state.error}`);
    const updateData: Record<string, unknown> = {
      status: 'error',
      error_message: state.error ? toUserErrorMessage(state.error) : 'העיבוד נכשל. ניתן לנסות שוב ("עבד מחדש")',
    };
    if (state.extractedData) {
      updateData.extracted_data = state.extractedData;
      updateData.validated_data = state.extractedData;
    }
    const saved = await writeRunResult(state, updateData);
    if (saved) await saveRunContext(state);
    return saved;
  }

  const data = state.extractedData;
  const validatedData = data ? withSupplierRule(data, state.supplierRule) : data;
  // Scored on what the reviewer sees (supplier-rule defaults applied)
  const confidence = computeConfidence(validatedData);
  console.log(
    kind === 'review'
      ? `[Supervisor] 💾 Saving state: REQUIRES MANUAL REVIEW (Total Cost: $${state.costMetrics.estimatedCostUsd})`
      : `[Supervisor] ✅ Saving state: AUTO-APPROVED (Total Cost: $${state.costMetrics.estimatedCostUsd})`
  );

  // extracted_data stays the AI output; supplier-rule defaults go into validated_data only.
  // No reviewed_at on auto-approve: those don't count toward accuracy / auto-approve eligibility.
  // (An invoice a human already reviewed is never auto-approved by a re-run: see writeRunResult.)
  const update: Record<string, unknown> = {
    extracted_data: data,
    validated_data: validatedData,
    status: kind,
    ai_confidence: confidence,
    error_message: null,
  };

  // limit(1), not maybeSingle(): the local mock DB client doesn't implement maybeSingle
  const { data: rows } = await supabase
    .from('invoices')
    .select('id, client_id, reviewed_at, resubmission_of, processing_run_id')
    .eq('id', state.invoiceId)
    .limit(1);
  const current = ((Array.isArray(rows) ? rows[0] : null) ?? null) as {
    client_id?: string;
    reviewed_at?: string | null;
    resubmission_of?: string | null;
    processing_run_id?: string | null;
  } | null;
  const runId = (state as PipelineRunState).runId ?? null;
  const owned = !!current && (!runId || current.processing_run_id === runId);

  let linkedTo: string | null = null;
  if (owned && current && !current.reviewed_at && !current.resubmission_of) {
    const plan = await planResubmissionLink(
      { id: state.invoiceId, client_id: current.client_id ?? state.tenantId, resubmission_of: null },
      validatedData ?? null,
      data ?? null
    );
    if (plan && (await linkReturnedToResubmission(plan.returnedId, state.invoiceId))) {
      linkedTo = plan.returnedId;
      update.resubmission_of = plan.returnedId;
      update.validated_data = plan.validated;
      console.log(`[Supervisor] Invoice ${state.invoiceId} is the corrected document of returned invoice ${plan.returnedId}`);
    }
  }

  const saved = await writeRunResult(state, update);
  if (!saved) {
    if (linkedTo) await unlinkReturnedFromResubmission(linkedTo, state.invoiceId);
    return false;
  }
  await saveRunContext(state);
  // A reviewed invoice keeps its validated_data (writeRunResult), so it is linked on what is stored
  if (current?.reviewed_at && !current.resubmission_of) await linkResubmission(state.invoiceId);
  return true;
}

export interface QueuedExtractionInput {
  invoiceId: string;
  runId: string;
  tenantId: string;
  fileUrl: string;
  mimeType: string;
  /** Extraction merged from the run's page chunks (src/shared/extractionChunks.ts). */
  extractedData: ExtractedData;
  retryCount: number;
  /** OCR text of the whole file (stored as few-shot context). */
  rawOcrText: string;
  ocrMetadata: OcrMetadata;
  /** OCR words of the extracted pages (boxes are snapped to them). */
  ocrWords: OcrWord[];
  splitSuggestion: SplitSuggestion | null;
  splitDetectionFailed: boolean;
  fewShotExampleIds: string[];
  costMetrics: CostMetrics;
}

export type QueuedExtractionOutcome =
  | { outcome: 'retry' }
  | { outcome: 'saved'; status: 'review' | 'approved' | 'error'; saved: boolean };

/**
 * The processing queue's last step (src/lib/processingQueue.ts): bbox snapping, validation and the
 * save, with the same rules as the graph's validate / save nodes. No LLM call, so it is short.
 * Returns 'retry' when the sums don't match and the one math retry is still due (the queue then
 * runs another extraction call in its own tick).
 */
export async function finalizeQueuedExtraction(input: QueuedExtractionInput): Promise<QueuedExtractionOutcome> {
  const tenantRules = await getTenantRules();
  const extracted: ExtractedData = { ...input.extractedData };
  if (input.ocrWords.length > 0) extracted.bboxes = matchBboxesWithOcr(extracted, input.ocrWords);

  const validation = await applyRunValidation({
    invoiceId: input.invoiceId,
    tenantId: input.tenantId,
    extractedData: extracted,
    tenantRules,
    rawOcrText: input.rawOcrText,
    splitSuggestion: input.splitSuggestion,
    pageCount: input.ocrMetadata.pageCount ?? null,
    splitDetectionFailed: input.splitDetectionFailed,
    ocrWords: input.ocrWords,
  });
  const route = routeAfterValidation(validation.validationResult, input.retryCount);
  if (route === 'retry') return { outcome: 'retry' };

  const state: PipelineRunState = {
    invoiceId: input.invoiceId,
    fileUrl: input.fileUrl,
    mimeType: input.mimeType,
    tenantId: input.tenantId,
    tenantRules,
    rawOcrText: input.rawOcrText,
    ocrMetadata: input.ocrMetadata,
    ocrWords: input.ocrWords,
    extractedData: validation.extractedData,
    validationResult: validation.validationResult,
    supplierRule: validation.supplierRule,
    retryCount: input.retryCount,
    status: 'processing',
    error: validation.error,
    costMetrics: input.costMetrics,
    useVisionFallback: false,
    splitSuggestion: input.splitSuggestion,
    fewShotExampleIds: input.fewShotExampleIds,
    runId: input.runId,
    splitDetectionFailed: input.splitDetectionFailed,
  };
  const status = route === 'save_error' ? 'error' : route === 'save_review' ? 'review' : 'approved';
  const saved = await saveRunOutcome(state, status);
  return { outcome: 'saved', status, saved };
}

// Define the StateGraph channels as any to bypass LangGraph's internal TS engine issues
const graph = new StateGraph<any>({
  channels: {
    invoiceId:        { value: (a: string, b: string) => b ?? a, default: () => '' },
    fileUrl:          { value: (a: string, b: string) => b ?? a, default: () => '' },
    mimeType:         { value: (a: string, b: string) => b ?? a, default: () => '' },
    tenantId:         { value: (a: string, b: string) => b ?? a, default: () => '' },
    tenantRules:      { value: (a: any, b: any) => b ?? a, default: () => null },
    rawOcrText:       { value: (a: any, b: any) => b ?? a, default: () => null },
    ocrMetadata:      { value: (a: any, b: any) => b ?? a, default: () => null },
    ocrWords:         { value: (a: any, b: any) => b ?? a, default: () => null },
    extractedData:    { value: (a: any, b: any) => b ?? a, default: () => null },
    validationResult: { value: (a: any, b: any) => b ?? a, default: () => null },
    supplierRule:     { value: (a: any, b: any) => (b === undefined ? a : b), default: () => null },
    retryCount:       { value: (a: number, b: number) => b ?? a, default: () => 0 },
    status:           { value: (a: any, b: any) => b ?? a, default: () => 'processing' },
    error:            { value: (a: any, b: any) => b ?? a, default: () => null },
    costMetrics:      {
      value: (a: any, b: any) => b ?? a,
      default: () => ({ ocrOpCount: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }),
    },
    useVisionFallback: { value: (a: boolean, b: boolean) => b ?? a, default: () => false },
    fewShot:          { value: (a: any, b: any) => b ?? a, default: () => null },
    fewShotExampleIds: { value: (a: any, b: any) => b ?? a, default: () => null },
    // null must overwrite: a re-run on the same thread (e.g. after a manual split) must not keep the old suggestion
    splitSuggestion:  { value: (a: any, b: any) => (b === undefined ? a : b), default: () => null },
    splitDetectionFailed: { value: (a: boolean, b: boolean) => (b === undefined ? a : b), default: () => false },
    runId:            { value: (a: any, b: any) => (b === undefined ? a : b), default: () => null },
    preOcr:           { value: (a: any, b: any) => (b === undefined ? a : b), default: () => null },
  },
})
  // 1. Initialize Rules node
  .addNode('init_rules', async (state: PipelineState) => {
    const rules = await getTenantRules();
    return { tenantRules: rules };
  })

  // 2. Preprocess node (Deterministic OCR Extraction)
  .addNode('preprocess', async (state: PipelineState & { preOcr?: PrecomputedOcr | null }) => {
    let rawOcrText: string;
    let ocrMetadata: OcrMetadata;
    let ocrOpCount: number;
    let pageTexts: string[] | undefined;
    let ocrWords: OcrWord[] | undefined;
    // Multi-invoice detection (heuristic pre-check first, LLM only when it can't decide)
    let splitSuggestion: SplitSuggestion | null = null;
    let splitDetectionFailed = false;
    let splitInputTokens = 0;
    let splitOutputTokens = 0;

    if (state.preOcr) {
      // The processing queue already ran OCR (page-batched over several ticks) and detection
      ({ rawOcrText, ocrMetadata, ocrOpCount, pageTexts, ocrWords } = state.preOcr);
      splitSuggestion = state.preOcr.splitSuggestion;
      splitDetectionFailed = state.preOcr.splitDetectionFailed;
      splitInputTokens = state.preOcr.splitInputTokens;
      splitOutputTokens = state.preOcr.splitOutputTokens;
    } else {
      ({ rawOcrText, ocrMetadata, ocrOpCount, pageTexts, ocrWords } = await preprocessInvoice(state.fileUrl, state.mimeType));
      if (pageTexts && pageTexts.length > 1) {
        const detection = await detectDocumentBoundaries(pageTexts);
        splitSuggestion = detection.suggestion;
        splitDetectionFailed = detection.failed === true;
        splitInputTokens = detection.inputTokens;
        splitOutputTokens = detection.outputTokens;
      }
    }

    const updatedMetrics = {
      ...state.costMetrics,
      ocrOpCount: state.costMetrics.ocrOpCount + ocrOpCount,
      inputTokens: state.costMetrics.inputTokens + splitInputTokens,
      outputTokens: state.costMetrics.outputTokens + splitOutputTokens,
    };
    updatedMetrics.estimatedCostUsd = calculateEstimatedCost(updatedMetrics);

    console.log(`[Supervisor] ⚙️ Preprocessing complete. OCR Ops: ${updatedMetrics.ocrOpCount}, Cost: $${updatedMetrics.estimatedCostUsd}`);

    // Default: keep the file whole and suggest the split to the reviewer.
    // Auto-split only behind AUTO_SPLIT_ENABLED and with high confidence.
    const splits = shouldAutoSplit(splitSuggestion) && splitSuggestion ? splitSuggestion.documents : null;
    if (isMultiDocument(splitSuggestion) && !splits) {
      console.log(`[Supervisor] ✂️ ${splitSuggestion.documents.length} documents detected (confidence ${splitSuggestion.confidence}); suggesting a split in review.`);
    }

    if (splits && splits.length > 1) {
      console.log(`[Supervisor] ✂️ Multi-invoice PDF detected. Auto-splitting into ${splits.length} parts...`);
      try {
        const response = await fetch(state.fileUrl);
        if (!response.ok) {
          throw new Error(`Failed to download original invoice file: ${response.statusText}`);
        }
        const fileBuffer = Buffer.from(await response.arrayBuffer());

        const { data: currentInvoice, error: fetchInvErr } = await supabase
          .from('invoices')
          .select('file_name')
          .eq('id', state.invoiceId)
          .single();

        if (fetchInvErr || !currentInvoice) {
          throw new Error(`Failed to fetch current invoice: ${fetchInvErr?.message}`);
        }

        const originalFileName = currentInvoice.file_name || 'invoice.pdf';
        const lastDot = originalFileName.lastIndexOf('.');
        const ext = lastDot !== -1 ? originalFileName.substring(lastDot) : '.pdf';
        const nameWithoutExt = lastDot !== -1 ? originalFileName.substring(0, lastDot) : originalFileName;

        let primaryFileUrl = state.fileUrl;
        let primaryFileName = originalFileName;
        let primaryRawOcrText = rawOcrText;
        let primaryOcrMetadata = ocrMetadata;
        let primaryOcrWords = ocrWords;

        const childIds: string[] = [];

        for (let idx = 0; idx < splits.length; idx++) {
          const split = splits[idx];
          const splitBuffer = await splitPdfBuffer(fileBuffer, split.start_page, split.end_page);
          const splitFileHash = sha256Hex(splitBuffer);
          const splitFileName = `${nameWithoutExt}_חלק_${idx + 1}${ext}`;
          const sanitizedBase = sanitizeStorageFilename(nameWithoutExt);
          const storageFileName = `${sanitizedBase}_part_${idx + 1}${ext}`;
          const uploadPath = `${state.tenantId}/${Date.now()}_${storageFileName}`;

          const { data: uploadData, error: uploadErr } = await supabase.storage
            .from('raw-invoices')
            .upload(uploadPath, splitBuffer, {
              contentType: 'application/pdf',
              upsert: true,
            });

          if (uploadErr || !uploadData) {
            throw new Error(`Failed to upload split PDF part ${idx + 1}: ${uploadErr?.message}`);
          }

          console.log(`[Supervisor]   - Part ${idx + 1}/${splits.length} split and uploaded to Storage.`);

          // Stored: a storage reference (no bearer token, QA #31). The run itself reads the part
          // through a short-lived signed URL.
          const splitFileUrl = storedFileUrlFor(uploadPath);
          const splitFetchUrl = await signObjectPath(uploadPath, PIPELINE_URL_TTL_SECONDS);
          if (!splitFetchUrl) {
            throw new Error(`Failed to create signed URL for split PDF part ${idx + 1}`);
          }
          const splitPageTexts = pageTexts ? pageTexts.slice(split.start_page - 1, split.end_page) : [];
          const splitRawOcrText = splitPageTexts.join('\n\n');
          const splitPageCount = split.end_page - split.start_page + 1;
          const splitOcrMetadata = {
            pageCount: splitPageCount,
            detectedLanguages: ocrMetadata?.detectedLanguages || ['he'],
            confidence: ocrMetadata?.confidence || 0.95,
          };

          const splitOcrWords = ocrWords
            ? ocrWords
                .filter((w) => w.page >= split.start_page && w.page <= split.end_page)
                .map((w) => ({ ...w, page: w.page - split.start_page + 1 }))
            : [];

          if (idx === 0) {
            primaryFileUrl = splitFetchUrl;
            primaryFileName = splitFileName;
            primaryRawOcrText = splitRawOcrText;
            primaryOcrMetadata = splitOcrMetadata;
            primaryOcrWords = splitOcrWords;

            // Only while this run still owns the row (a superseded run must not repoint the file)
            let repoint = supabase
              .from('invoices')
              .update({
                file_url: splitFileUrl,
                file_name: splitFileName,
                updated_at: new Date().toISOString(),
              })
              .eq('id', state.invoiceId);
            const runId = (state as PipelineRunState).runId;
            if (runId) repoint = repoint.eq('processing_run_id', runId);
            const { data: repointed, error: repointErr } = await repoint.select('id');
            if (repointErr || !Array.isArray(repointed) || repointed.length === 0) {
              throw new Error(`Could not point invoice ${state.invoiceId} at split part 1 (superseded or DB error)`);
            }
            // The invoice now points at the split part, so its fingerprint changes with it
            await saveInvoiceFileHash(supabase, state.invoiceId, splitFileHash);
          } else {
            const { data: newInvoice, error: insertErr } = await supabase
              .from('invoices')
              .insert({
                client_id: state.tenantId,
                file_url: splitFileUrl,
                file_name: splitFileName,
                status: 'processing',
              })
              .select()
              .single();

            if (insertErr || !newInvoice) {
              console.error(`[Supervisor] Failed to insert split invoice part ${idx + 1}:`, insertErr);
              continue;
            }
            await saveInvoiceFileHash(supabase, newInvoice.id, splitFileHash);

            childIds.push(newInvoice.id);
          }
        }

        if (childIds.length > 0) {
          // Queued, not run inline: each part gets its own short ticks (src/lib/processingQueue.ts)
          const { enqueueProcessing } = await import('@/lib/processingQueue');
          for (const childId of childIds) {
            const queued = await enqueueProcessing(childId, { mimeType: 'application/pdf' });
            if (!queued.ok) console.error(`[Supervisor] Could not queue split part ${childId}: ${queued.error}`);
          }
          console.log(`[Supervisor] Queued ${childIds.length} split parts for processing.`);
        }

        return {
          fileUrl: primaryFileUrl,
          rawOcrText: primaryRawOcrText,
          ocrMetadata: primaryOcrMetadata,
          ocrWords: primaryOcrWords,
          costMetrics: updatedMetrics,
          splitSuggestion: null,
        };
      } catch (err) {
        console.error('[Supervisor] Splitting PDF failed, proceeding with original PDF:', err);
      }
    }

    return {
      rawOcrText,
      ocrMetadata,
      ocrWords,
      costMetrics: updatedMetrics,
      // Falls back to a review suggestion when an auto-split failed
      splitSuggestion,
      splitDetectionFailed,
    };
  })

  // 3. Extract Data node (Text-first with vision fallback)
  .addNode('extract', async (state: PipelineState) => {
    const isRetry = state.extractedData !== null;
    const useVision = state.useVisionFallback || isRetry;
    
    console.log(`[Supervisor] 🔍 Extracting invoice fields (Retry: ${isRetry}, Vision Mode: ${useVision})`);

    // Past reviewed invoices of the same supplier as few-shot examples (best-effort, loaded once per run)
    const fewShot = state.fewShot ?? await loadFewShotExamples(supabase, {
      invoiceId: state.invoiceId,
      tenantId: state.tenantId,
      ocrText: state.rawOcrText,
    });

    const { extractedData, inputTokens, outputTokens, fewShotInvoiceIds } = await extractInvoiceData(
      state.rawOcrText,
      state.fileUrl,
      state.mimeType,
      useVision,
      isRetry,
      fewShot
    );

    // Logged on every extraction so accuracy with/without examples can be compared later
    console.log(
      `[Supervisor] 📚 Few-shot examples used: ${fewShotInvoiceIds.length}` +
      (fewShotInvoiceIds.length > 0
        ? ` (supplier ${fewShot.supplierVatId}, invoices ${fewShotInvoiceIds.join(', ')})`
        : '')
    );

    // Overwrite bounding boxes with coordinates from Google Vision OCR for pixel-perfect accuracy
    if (extractedData && state.ocrWords && state.ocrWords.length > 0) {
      console.log('[Supervisor] 🎯 Matching extracted fields with exact Google Vision OCR coordinates...');
      extractedData.bboxes = matchBboxesWithOcr(extractedData, state.ocrWords);
    }

    const updatedMetrics = {
      ...state.costMetrics,
      inputTokens: state.costMetrics.inputTokens + inputTokens,
      outputTokens: state.costMetrics.outputTokens + outputTokens,
    };
    updatedMetrics.estimatedCostUsd = calculateEstimatedCost(updatedMetrics);

    console.log(`[Supervisor] 📄 Extraction complete. LLM Cost: $${(updatedMetrics.estimatedCostUsd - (updatedMetrics.ocrOpCount * 0.0015)).toFixed(4)} (Total cost: $${updatedMetrics.estimatedCostUsd})`);

    return { 
      extractedData,
      fewShot,
      fewShotExampleIds: fewShotInvoiceIds,
      costMetrics: updatedMetrics,
      retryCount: isRetry ? state.retryCount + 1 : state.retryCount,
      useVisionFallback: useVision
    };
  })

  // 4. Deterministic Validation node
  .addNode('validate', async (state: PipelineState) => {
    if (!state.extractedData || !state.tenantRules) {
      throw new Error('Missing extraction data or rules for validation');
    }
    return applyRunValidation({
      invoiceId: state.invoiceId,
      tenantId: state.tenantId,
      extractedData: state.extractedData,
      tenantRules: state.tenantRules,
      rawOcrText: state.rawOcrText,
      splitSuggestion: state.splitSuggestion ?? null,
      pageCount: state.ocrMetadata?.pageCount ?? null,
      splitDetectionFailed: (state as PipelineRunState).splitDetectionFailed === true,
      ocrWords: state.ocrWords,
    });
  })

  // 5. Save review node (Interrupt point before approval)
  .addNode('save_review', async (state: PipelineState) => {
    await saveRunOutcome(state, 'review');
    return { status: 'review' };
  })

  // 6. Approval node (HITL node) - Cast to any to align with StateGraph<any>
  .addNode('approval', approvalNode as any)

  // 7. Save Auto-Approved node
  .addNode('save_success', async (state: PipelineState) => {
    await saveRunOutcome(state, 'approved');
    return { status: 'approved' };
  })

  // 8. Save Error node
  .addNode('save_error', async (state: PipelineState) => {
    await saveRunOutcome(state, 'error');
    return { status: 'error' };
  })

  // Define Graph Edges
  .addEdge('__start__', 'init_rules')
  .addEdge('init_rules', 'preprocess')
  .addEdge('preprocess', 'extract')
  .addEdge('extract', 'validate')
  
  // Conditional Edge after validation
  .addConditionalEdges('validate', (state: PipelineState) => routeAfterValidation(state.validationResult, state.retryCount), {
    retry: 'extract',
    save_review: 'save_review',
    save_success: 'save_success',
    save_error: 'save_error'
  })

  // Map other nodes to their end states or next steps
  .addEdge('save_review', 'approval')
  .addEdge('approval', END)
  .addEdge('save_success', END)
  .addEdge('save_error', END);

// Compile the graph with persistent memory checkpointer & interrupt before manual approval
export const checkpointer = new MemorySaver();
export const compiledGraph = graph.compile({
  checkpointer,
  interruptBefore: ['approval'],
});

/**
 * Executes the entire orchestrator flow asynchronously.
 */
export async function runOrchestrationPipeline(
  invoiceId: string,
  fileUrl: string,
  mimeType: string,
  tenantId: string,
  options: PipelineRunOptions = {}
): Promise<void> {
  const runId = options.runId ?? null;
  try {
    // fileUrl is the stored storage reference (or a legacy signed URL): the run reads the file
    // through a fresh short-lived signed URL (QA #31). Anything else (mock mode) is used as is.
    const fetchUrl = (await signedInvoiceFileUrl(fileUrl, tenantId, PIPELINE_URL_TTL_SECONDS)) ?? fileUrl;
    await compiledGraph.invoke(
      {
        invoiceId,
        fileUrl: fetchUrl,
        mimeType,
        tenantId,
        runId,
        preOcr: options.preOcr ?? null,
        splitSuggestion: null,
        splitDetectionFailed: false,
        extractedData: null,
        validationResult: null,
        fewShot: null,
        fewShotExampleIds: null,
        retryCount: 0,
        status: 'processing',
        rawOcrText: null,
        ocrMetadata: null,
        costMetrics: { ocrOpCount: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
        useVisionFallback: false,
      },
      { configurable: { thread_id: invoiceId } }
    );
  } catch (err) {
    console.error(`Orchestration pipeline execution error for ${invoiceId}:`, err);
    // Raw detail stays in the log; the user sees a Hebrew message (and only if this run still owns the row)
    let query = supabase.from('invoices').update({
      status: 'error',
      error_message: toUserErrorMessage(err),
      processing_stage: null,
      processing_progress: null,
      updated_at: new Date().toISOString(),
    }).eq('id', invoiceId);
    if (runId) query = query.eq('processing_run_id', runId);
    await query;
    throw err;
  }
}
