// Multi-invoice PDF splitting: pure helpers shared by the pipeline (boundary detection),
// the split API route (server-side range validation) and the review UI (suggestion banner).
// Pages are always 1-based and ranges are inclusive.

/**
 * When true, the processing queue splits a PDF on its own if the detection is confident enough
 * (QA: was false since 2026-10-30, so every multi-invoice scan stayed one review row). Server-side
 * override: AUTO_SPLIT_ENABLED=false (src/lib/processingQueue.ts, autoSplitSettings).
 */
export const AUTO_SPLIT_ENABLED = true;
/**
 * Default minimum overall confidence for an automatic split; below it the review screen only
 * suggests the split. Server-side override: AUTO_SPLIT_MIN_CONFIDENCE (0.5-1 or 50-100).
 */
export const AUTO_SPLIT_MIN_CONFIDENCE = 0.9;
/** Confidence assigned when explicit "page X of N" markers fully explain the page grouping. */
export const PAGE_MARKER_CONFIDENCE = 0.92;
/** Pages with less non-whitespace text than this are treated as unreadable for boundary detection. */
const MIN_MEANINGFUL_CHARS = 20;

export interface PageRange {
  start_page: number;
  end_page: number;
}

export interface SplitDocument extends PageRange {
  confidence: number | null; // per-document confidence from the LLM, 0-1
  reason: string | null;     // short Hebrew explanation (supplier / invoice number)
}

export type SplitSuggestionSource = 'page_markers' | 'llm';

/** Stored on invoices.extracted_data.split_suggestion; only set when more than one document was detected. */
export interface SplitSuggestion {
  page_count: number;
  documents: SplitDocument[];
  confidence: number; // overall 0-1
  source: SplitSuggestionSource;
  detected_at: string; // ISO timestamp
}

export type RangeValidation =
  | { ok: true; ranges: PageRange[] }
  | { ok: false; error: string };

type PageValue = { kind: 'missing' } | { kind: 'invalid' } | { kind: 'ok'; value: number };

/** A page number field: missing, not a whole number (10.5, 'abc'), or a whole number. */
function readPage(obj: Record<string, unknown>, ...keys: string[]): PageValue {
  let present = false;
  for (const key of keys) {
    const v = obj[key];
    if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) continue;
    present = true;
    if (typeof v === 'number' && Number.isInteger(v)) return { kind: 'ok', value: v };
    if (typeof v === 'string' && /^\d+$/.test(v.trim())) return { kind: 'ok', value: parseInt(v.trim(), 10) };
  }
  return present ? { kind: 'invalid' } : { kind: 'missing' };
}

export const SINGLE_PAGE_SPLIT_ERROR = 'המסמך מכיל עמוד אחד בלבד (ייתכן שכבר פוצל) ולכן לא ניתן לפצל אותו';
export const MAX_SPLIT_PARTS = 100;

/**
 * Shape check of a split request before the file is downloaded: an array of 2..MAX_SPLIT_PARTS
 * objects whose start / end pages are whole numbers >= 1 with start <= end. Coverage of the real
 * page count is checked afterwards by validateSplitRanges.
 */
export function checkSplitRequestShape(raw: unknown): { ok: true } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: 'לא התקבלו טווחי עמודים לפיצול' };
  if (raw.length < 2) return { ok: false, error: 'נדרשים לפחות שני חלקים כדי לפצל את המסמך' };
  if (raw.length > MAX_SPLIT_PARTS) return { ok: false, error: `ניתן לפצל לכל היותר ל-${MAX_SPLIT_PARTS} חלקים` };
  for (const item of raw) {
    if (!item || typeof item !== 'object') return { ok: false, error: 'טווח עמודים לא תקין' };
    const obj = item as Record<string, unknown>;
    const start = readPage(obj, 'start_page', 'startPage');
    const end = readPage(obj, 'end_page', 'endPage');
    if (start.kind === 'missing' || end.kind === 'missing') return { ok: false, error: 'טווח עמודים חסר עמוד התחלה או סיום' };
    if (start.kind === 'invalid' || end.kind === 'invalid') return { ok: false, error: 'מספר עמוד חייב להיות מספר שלם' };
    if (start.value < 1 || end.value < 1) return { ok: false, error: 'מספרי עמודים מתחילים מ-1' };
    if (start.value > end.value) return { ok: false, error: `עמוד התחלה (${start.value}) גדול מעמוד סיום (${end.value})` };
  }
  return { ok: true };
}

/**
 * Validates page ranges against the document's page count: 1-based, start <= end,
 * no overlaps, no gaps, together covering every page exactly once.
 * Accepts snake_case (pipeline/LLM) or camelCase (split API body) keys. Returns ranges sorted by start page.
 */
export function validateSplitRanges(raw: unknown, pageCount: number): RangeValidation {
  if (!Number.isInteger(pageCount) || pageCount < 1) {
    return { ok: false, error: 'מספר העמודים במסמך אינו תקין' };
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, error: 'לא התקבלו טווחי עמודים' };
  }
  if (pageCount < 2 && raw.length > 1) {
    return { ok: false, error: SINGLE_PAGE_SPLIT_ERROR };
  }

  const ranges: PageRange[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      return { ok: false, error: 'טווח עמודים לא תקין' };
    }
    const obj = item as Record<string, unknown>;
    const startValue = readPage(obj, 'start_page', 'startPage');
    const endValue = readPage(obj, 'end_page', 'endPage');
    if (startValue.kind === 'missing' || endValue.kind === 'missing') {
      return { ok: false, error: 'טווח עמודים חסר עמוד התחלה או סיום' };
    }
    if (startValue.kind === 'invalid' || endValue.kind === 'invalid') {
      return { ok: false, error: 'מספר עמוד חייב להיות מספר שלם' };
    }
    const start = startValue.value;
    const end = endValue.value;
    if (start < 1 || end < 1 || start > pageCount || end > pageCount) {
      return { ok: false, error: `מספרי עמודים חייבים להיות בין 1 ל- ${pageCount}` };
    }
    if (start > end) {
      return { ok: false, error: `עמוד התחלה (${start}) גדול מעמוד סיום (${end})` };
    }
    ranges.push({ start_page: start, end_page: end });
  }

  ranges.sort((a, b) => a.start_page - b.start_page || a.end_page - b.end_page);

  let expectedStart = 1;
  for (const r of ranges) {
    if (r.start_page < expectedStart) {
      return { ok: false, error: `עמוד ${r.start_page} מופיע ביותר מטווח אחד` };
    }
    if (r.start_page > expectedStart) {
      return { ok: false, error: `חסרים עמודים בפיצול: ${formatPageSpan(expectedStart, r.start_page - 1)}` };
    }
    expectedStart = r.end_page + 1;
  }
  if (expectedStart <= pageCount) {
    return { ok: false, error: `חסרים עמודים בפיצול: ${formatPageSpan(expectedStart, pageCount)}` };
  }

  return { ok: true, ranges };
}

function formatPageSpan(start: number, end: number): string {
  return start === end ? String(start) : `${start}-${end}`;
}

/** "1-2, 3, 4-5" - the format the manual split dialog accepts. */
export function formatRangesForInput(ranges: PageRange[]): string {
  return ranges.map((r) => formatPageSpan(r.start_page, r.end_page)).join(', ');
}

// ---------------------------------------------------------------------------
// Heuristic pre-check (no LLM)
// ---------------------------------------------------------------------------

export interface PageMarker {
  page: number;
  of: number;
}

// "עמוד 2 מתוך 3", "דף 2/3", "Page 2 of 3". Requires the עמוד/דף/page prefix so that
// "1 מתוך 3 תשלומים" (installments) doesn't count; the trailing lookahead rejects dates like "דף 1/12/2025".
const PAGE_MARKER_PATTERNS: RegExp[] = [
  /(?:עמוד|עמ['׳]|דף)\s*(\d{1,3})\s*(?:מתוך|מ-|\/)\s*(\d{1,3})(?!\d|[/.]\d)/g,
  /page\s*(\d{1,3})\s*(?:of|\/)\s*(\d{1,3})(?!\d|[/.]\d)/gi,
];

/** First plausible "page X of N" marker on the page, or null. */
export function extractPageMarker(text: string): PageMarker | null {
  if (!text) return null;
  for (const pattern of PAGE_MARKER_PATTERNS) {
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(text)) !== null) {
      const page = parseInt(m[1], 10);
      const of = parseInt(m[2], 10);
      if (page >= 1 && of >= 1 && page <= of && of <= 500) return { page, of };
    }
  }
  return null;
}

// "חשבונית מס 12345", "חשבונית מס/קבלה מס' 12345", "קבלה מספר 987", "Invoice No. 4411"
const INVOICE_NUMBER_PATTERN =
  /(?:חשבונית(?:\s*מס)?(?:\s*[/\\]?\s*קבלה)?|קבלה|invoice)\s*(?:מס(?:פר|['׳"])?|no\.?|number|#)?\s*[:.]?\s*(\d{3,12})/gi;

/** Document numbers printed next to an invoice/receipt title on the page (deduplicated, in order). */
export function extractInvoiceNumbers(text: string): string[] {
  if (!text) return [];
  const found: string[] = [];
  INVOICE_NUMBER_PATTERN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INVOICE_NUMBER_PATTERN.exec(text)) !== null) {
    if (!found.includes(m[1])) found.push(m[1]);
  }
  return found;
}

/**
 * Groups pages using "page X of N" markers alone. Only succeeds when every page carries a marker
 * and the sequence is fully consistent (each document runs 1..N without gaps); otherwise null.
 */
export function rangesFromPageMarkers(markers: (PageMarker | null)[]): PageRange[] | null {
  if (markers.length === 0 || markers.some((m) => m === null)) return null;
  const ranges: PageRange[] = [];
  let i = 0;
  while (i < markers.length) {
    const first = markers[i]!;
    if (first.page !== 1) return null;
    const end = i + first.of - 1;
    if (end >= markers.length) return null;
    for (let k = 1; k < first.of; k++) {
      const m = markers[i + k]!;
      if (m.page !== k + 1 || m.of !== first.of) return null;
    }
    ranges.push({ start_page: i + 1, end_page: end + 1 });
    i = end + 1;
  }
  return ranges;
}

export interface PageHint {
  page: number;
  marker: PageMarker | null;
  invoice_numbers: string[];
  has_text: boolean;
}

export type SplitPrecheck =
  | { kind: 'single'; reason: string }
  | { kind: 'resolved'; ranges: PageRange[]; confidence: number; reason: string }
  | { kind: 'needs_llm'; hints: PageHint[] };

function meaningfulLength(text: string): number {
  return (text || '').replace(/\s+/g, '').length;
}

/**
 * Cheap pre-check before asking the LLM. Single pages, PDFs without enough readable text and
 * documents whose "page X of N" markers explain the grouping are decided here; everything else
 * goes to the LLM together with the per-page hints.
 */
export function precheckSplit(pageTexts: string[]): SplitPrecheck {
  const pageCount = pageTexts.length;
  if (pageCount <= 1) return { kind: 'single', reason: 'single page' };

  const hints: PageHint[] = pageTexts.map((text, idx) => ({
    page: idx + 1,
    marker: extractPageMarker(text),
    invoice_numbers: extractInvoiceNumbers(text),
    has_text: meaningfulLength(text) >= MIN_MEANINGFUL_CHARS,
  }));

  if (hints.filter((h) => h.has_text).length < 2) {
    return { kind: 'single', reason: 'not enough readable text to compare pages' };
  }

  const markerRanges = rangesFromPageMarkers(hints.map((h) => h.marker));
  if (markerRanges) {
    if (markerRanges.length === 1) {
      return { kind: 'single', reason: `page markers show one ${pageCount}-page document` };
    }
    return {
      kind: 'resolved',
      ranges: markerRanges,
      confidence: PAGE_MARKER_CONFIDENCE,
      reason: `page markers show ${markerRanges.length} documents`,
    };
  }

  return { kind: 'needs_llm', hints };
}

/** Compact one-line-per-page summary of the heuristic signals, passed to the LLM as context. */
export function describeHints(hints: PageHint[]): string {
  return hints
    .map((h) => {
      const parts: string[] = [];
      if (h.marker) parts.push(`סימון "עמוד ${h.marker.page} מתוך ${h.marker.of}"`);
      if (h.invoice_numbers.length > 0) parts.push(`מספרי מסמך: ${h.invoice_numbers.join(', ')}`);
      if (!h.has_text) parts.push('כמעט ללא טקסט');
      return `עמוד ${h.page}: ${parts.length > 0 ? parts.join(' · ') : 'אין סימנים'}`;
    })
    .join('\n');
}

/** Keeps the head (title, supplier, invoice number) and tail (totals, page footer) of a long page. */
export function truncatePageText(text: string, maxChars: number): string {
  const clean = (text || '').trim();
  if (clean.length <= maxChars) return clean;
  const tail = Math.floor(maxChars * 0.3);
  const head = maxChars - tail;
  return `${clean.slice(0, head)}\n[...]\n${clean.slice(clean.length - tail)}`;
}

// ---------------------------------------------------------------------------
// LLM result parsing & decisions
// ---------------------------------------------------------------------------

function clampConfidence(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.min(1, Math.max(0, v));
}

export type ParsedSplitResult =
  | { ok: true; suggestion: SplitSuggestion }
  | { ok: false; error: string };

/**
 * Turns the LLM tool input ({ documents: [{ start_page, end_page, confidence, reason }], confidence })
 * into a validated SplitSuggestion. The overall confidence is capped by the weakest document.
 */
export function parseLlmSplitResult(
  raw: unknown,
  pageCount: number,
  now: Date = new Date()
): ParsedSplitResult {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'empty tool input' };
  const obj = raw as Record<string, unknown>;
  const docs = obj.documents;

  const validation = validateSplitRanges(docs, pageCount);
  if (!validation.ok) return { ok: false, error: validation.error };

  const byStart = new Map<number, Record<string, unknown>>();
  for (const d of docs as Record<string, unknown>[]) {
    const start = readPage(d, 'start_page', 'startPage');
    if (start.kind === 'ok') byStart.set(start.value, d);
  }

  const documents: SplitDocument[] = validation.ranges.map((r) => {
    const src = byStart.get(r.start_page) ?? {};
    const reason = typeof src.reason === 'string' && src.reason.trim() ? src.reason.trim().slice(0, 200) : null;
    return { ...r, confidence: clampConfidence(src.confidence), reason };
  });

  const docConfidences = documents.map((d) => d.confidence).filter((c): c is number => c !== null);
  const overallRaw = clampConfidence(obj.confidence);
  const weakest = docConfidences.length > 0 ? Math.min(...docConfidences) : null;
  let confidence = overallRaw ?? weakest ?? 0.5;
  if (weakest !== null) confidence = Math.min(confidence, weakest);

  return {
    ok: true,
    suggestion: {
      page_count: pageCount,
      documents,
      confidence: Math.round(confidence * 100) / 100,
      source: 'llm',
      detected_at: now.toISOString(),
    },
  };
}

export function buildSplitSuggestion(
  ranges: PageRange[],
  confidence: number,
  source: SplitSuggestionSource,
  pageCount: number,
  now: Date = new Date()
): SplitSuggestion {
  return {
    page_count: pageCount,
    documents: ranges.map((r) => ({ ...r, confidence: null, reason: null })),
    confidence: Math.round((clampConfidence(confidence) ?? 0) * 100) / 100,
    source,
    detected_at: now.toISOString(),
  };
}

/** True when the suggestion says the file holds more than one document. */
export function isMultiDocument(suggestion: SplitSuggestion | null | undefined): suggestion is SplitSuggestion {
  return !!suggestion && Array.isArray(suggestion.documents) && suggestion.documents.length > 1;
}

export function shouldAutoSplit(
  suggestion: SplitSuggestion | null | undefined,
  enabled: boolean = AUTO_SPLIT_ENABLED,
  minConfidence: number = AUTO_SPLIT_MIN_CONFIDENCE
): boolean {
  return enabled && isMultiDocument(suggestion) && suggestion.confidence >= minConfidence;
}

/**
 * The suggestion to show in the review UI, or null when there's nothing to suggest or it no longer
 * fits the file (e.g. the file was already split and now has a different page count).
 */
export function usableSuggestion(
  suggestion: SplitSuggestion | null | undefined,
  currentPageCount: number | null
): SplitSuggestion | null {
  if (!isMultiDocument(suggestion)) return null;
  if (currentPageCount !== null && suggestion.page_count !== currentPageCount) return null;
  const check = validateSplitRanges(suggestion.documents, suggestion.page_count);
  return check.ok ? suggestion : null;
}
