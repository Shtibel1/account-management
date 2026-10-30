// Pure rules for resumable extraction (QA round 2: N5 / N14 / N22). A single LLM call over the
// whole text of a long PDF can take minutes, far past the ~28 s Amplify response limit, so the
// processing queue extracts in steps: one LLM call per tick, each over a few pages, with every
// result stored in processing_jobs.extract_state before the next step starts. A killed tick costs
// at most its own call. No DB / network here: src/lib/processingQueue.ts drives these steps.

import type { BboxMap, ExtractedData, FieldBbox, FieldConfidenceMap, LineItem } from '@/shared/types';
import type { SplitSuggestion } from '@/shared/documentSplit';
import { usableSuggestion } from '@/shared/documentSplit';
import { MAX_LINE_ITEMS } from '@/shared/lineItems';
import type { FewShotExample } from '@/shared/fewshot';

/** Pages sent to the model in one extraction call when a document is long. */
export const EXTRACT_PAGES_PER_CHUNK = 3;
/** OCR characters per extraction call (a page of dense line items can be long on its own). */
export const EXTRACT_CHARS_PER_CHUNK = 12_000;
/** Up to this many pages / characters a document is extracted in one call, as before. */
export const SINGLE_CALL_MAX_PAGES = 3;
export const SINGLE_CALL_MAX_CHARS = 18_000;

export interface PageSpan {
  start: number; // 1-based, inclusive
  end: number;   // 1-based, inclusive
}

export interface ChunkResult {
  data: ExtractedData;
  input_tokens: number;
  output_tokens: number;
}

export type ExtractPhase = 'chunks' | 'retry' | 'finalize';

/** processing_jobs.extract_state: everything extraction needs to resume in the next tick. */
export interface ExtractState {
  v: 1;
  /** Pages of the document this invoice row stands for (the first one of a multi-document file). */
  range: PageSpan;
  chunks: PageSpan[];
  /** One per chunk; null until that chunk's call finished. */
  results: (ChunkResult | null)[];
  /** Few-shot examples, looked up once per run (null = not looked up yet). */
  few_shot: { examples: FewShotExample[]; supplierVatId: string | null } | null;
  few_shot_ids: string[];
  /** Math retries done (the pipeline retries a sum mismatch once). */
  retry_count: number;
  phase: ExtractPhase;
}

function textLength(pageTexts: string[], start: number, end: number): number {
  let n = 0;
  for (let p = start; p <= end; p++) n += (pageTexts[p - 1] ?? '').length;
  return n;
}

/**
 * The pages to extract. A file that looks like several documents is shown to the reviewer with a
 * split suggestion and can't be approved as one, so its row is extracted from the first document
 * only (the parts are extracted on their own after the split). Otherwise the whole file.
 */
export function extractionRange(pageCount: number, suggestion: SplitSuggestion | null | undefined): PageSpan {
  const total = Math.max(1, pageCount);
  const usable = usableSuggestion(suggestion ?? null, total);
  if (usable) {
    const first = [...usable.documents].sort((a, b) => a.start_page - b.start_page)[0];
    if (first && first.start_page >= 1 && first.end_page >= first.start_page && first.end_page <= total) {
      return { start: first.start_page, end: first.end_page };
    }
  }
  return { start: 1, end: total };
}

/** Splits the range into calls of a few pages each; short documents stay one call. */
export function planExtractionChunks(pageTexts: string[], range: PageSpan): PageSpan[] {
  const pages = range.end - range.start + 1;
  if (pages <= SINGLE_CALL_MAX_PAGES && textLength(pageTexts, range.start, range.end) <= SINGLE_CALL_MAX_CHARS) {
    return [{ ...range }];
  }
  const chunks: PageSpan[] = [];
  let start = range.start;
  while (start <= range.end) {
    let end = start;
    while (
      end + 1 <= range.end &&
      end + 1 - start + 1 <= EXTRACT_PAGES_PER_CHUNK &&
      textLength(pageTexts, start, end + 1) <= EXTRACT_CHARS_PER_CHUNK
    ) {
      end++;
    }
    chunks.push({ start, end });
    start = end + 1;
  }
  return chunks;
}

export function initialExtractState(pageTexts: string[], pageCount: number, suggestion: SplitSuggestion | null | undefined): ExtractState {
  const range = extractionRange(pageCount, suggestion);
  const chunks = planExtractionChunks(pageTexts, range);
  return { v: 1, range, chunks, results: chunks.map(() => null), few_shot: null, few_shot_ids: [], retry_count: 0, phase: 'chunks' };
}

/** A stored state that still fits this job (else extraction starts over). */
export function isValidExtractState(value: unknown, pageCount: number): value is ExtractState {
  const s = value as ExtractState | null;
  if (!s || typeof s !== 'object' || s.v !== 1 || !Array.isArray(s.chunks) || !Array.isArray(s.results)) return false;
  if (s.chunks.length === 0 || s.chunks.length !== s.results.length) return false;
  if (!s.range || s.range.start < 1 || s.range.end > Math.max(1, pageCount)) return false;
  return s.phase === 'chunks' || s.phase === 'retry' || s.phase === 'finalize';
}

export function nextChunkIndex(state: ExtractState): number | null {
  const i = state.results.findIndex((r) => r === null);
  return i === -1 ? null : i;
}

/** OCR text of a page span. */
export function chunkText(pageTexts: string[], span: PageSpan): string {
  return pageTexts.slice(span.start - 1, span.end).join('\n\n');
}

/** Context line for a call that sees only part of a document. */
export function chunkHint(state: ExtractState, index: number): string | null {
  if (state.chunks.length <= 1) return null;
  const span = state.chunks[index];
  return `זהו חלק ${index + 1} מתוך ${state.chunks.length} של אותו מסמך (עמודים ${span.start}-${span.end} מתוך ${state.range.start}-${state.range.end}). ` +
    'חלץ רק את מה שמופיע בחלק זה: שורות הפריטים שבו, ושדות הכותרת והסכומים רק אם הם מודפסים כאן.';
}

const HEADER_FIELDS = [
  'supplier_name', 'supplier_vat_id', 'invoice_number', 'invoice_date', 'expense_category',
  'allocation_number', 'bank_name', 'bank_branch_code', 'bank_branch_name', 'bank_account',
] as const;
const AMOUNT_FIELDS = ['amount_before_vat', 'vat_amount', 'total_amount'] as const;

function present(v: unknown): boolean {
  return v !== null && v !== undefined && !(typeof v === 'string' && v.trim() === '');
}

function shiftBbox(b: FieldBbox | undefined, offset: number): FieldBbox | undefined {
  if (!b) return undefined;
  return offset > 0 && typeof b.page === 'number' ? { ...b, page: b.page + offset } : b;
}

/** Index of the chunk the amounts come from: the last one with a printed total (totals end a document). */
export function amountsChunkIndex(state: ExtractState): number {
  for (let i = state.results.length - 1; i >= 0; i--) {
    if (present(state.results[i]?.data.total_amount)) return i;
  }
  return state.results.length - 1;
}

/**
 * Merges the per-chunk results into one invoice: header fields from the first chunk that has them,
 * the amounts as one consistent set from the chunk with the (last) printed total, and the line
 * items of all chunks in page order. One chunk = its own result unchanged.
 */
export function mergeChunkResults(state: ExtractState): ExtractedData {
  const done = state.results.map((r, i) => ({ r, i })).filter((x): x is { r: ChunkResult; i: number } => x.r !== null);
  if (done.length === 0) throw new Error('No extraction results to merge');
  if (state.chunks.length === 1) return done[0].r.data;

  const out: Record<string, unknown> = {};
  const confidence: FieldConfidenceMap = {};
  const bboxes: BboxMap = {};
  const take = (field: string, i: number, value: unknown) => {
    out[field] = value;
    const data = state.results[i]!.data;
    const conf = (data.field_confidence as Record<string, number> | undefined)?.[field];
    if (typeof conf === 'number') (confidence as Record<string, number>)[field] = conf;
    const box = shiftBbox((data.bboxes as Record<string, FieldBbox | undefined> | undefined)?.[field], state.chunks[i].start - 1);
    if (box) (bboxes as Record<string, FieldBbox>)[field] = box;
  };

  for (const field of HEADER_FIELDS) {
    const hit = done.find(({ r }) => present((r.data as unknown as Record<string, unknown>)[field]));
    if (hit) take(field, hit.i, (hit.r.data as unknown as Record<string, unknown>)[field]);
    else out[field] = null;
  }

  const amountsAt = amountsChunkIndex(state);
  const amountsFrom = state.results[amountsAt];
  for (const field of AMOUNT_FIELDS) {
    if (amountsFrom && present(amountsFrom.data[field])) {
      take(field, amountsAt, amountsFrom.data[field]);
      continue;
    }
    // No printed total anywhere: the last chunk that has this amount
    const hit = [...done].reverse().find(({ r }) => present(r.data[field]));
    if (hit) take(field, hit.i, hit.r.data[field]);
    else out[field] = null;
  }

  const items: LineItem[] = [];
  for (const { r } of done) {
    for (const item of r.data.line_items ?? []) {
      if (items.length >= MAX_LINE_ITEMS) break;
      items.push(item);
    }
  }
  return {
    ...(out as unknown as ExtractedData),
    line_items: items.length > 0 ? items : null,
    field_confidence: Object.keys(confidence).length > 0 ? confidence : undefined,
    bboxes,
  };
}

/** Token totals of all calls so far (cost metrics). */
export function extractionTokens(state: ExtractState): { input: number; output: number } {
  return state.results.reduce(
    (acc, r) => ({ input: acc.input + (r?.input_tokens ?? 0), output: acc.output + (r?.output_tokens ?? 0) }),
    { input: 0, output: 0 }
  );
}
