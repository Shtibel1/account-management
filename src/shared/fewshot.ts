// Per-supplier few-shot examples for extraction ("instant learning" without training):
// past invoices of the same supplier that a reviewer approved are shown to the model as
// OCR text + the final values, with the fields the model got wrong called out.
// Everything here is pure; the DB loader lives in src/lib/fewshot.ts.
import type { ExtractedData } from '@/shared/types';
import { isValidVatIdChecksum, normalizeVatId } from '@/shared/vatId';

export const FEWSHOT_MAX_EXAMPLES = 3;
/** Per-example OCR text cap (characters). */
export const FEWSHOT_OCR_CHAR_CAP = 2500;
/** Hard cap on the whole examples block (characters), so the prompt stays bounded. */
export const FEWSHOT_TOTAL_CHAR_BUDGET = 10000;
/** Max VAT-id candidates taken from one OCR text (bounds the DB `in` filter). */
export const FEWSHOT_MAX_CANDIDATES = 20;
/** Long free-text values in an example are clipped to this many characters. */
const MAX_VALUE_CHARS = 200;

// The tool-input fields an example demonstrates (same list as TRACKED_FIELDS in src/lib/corrections.ts).
export const EXAMPLE_FIELDS = [
  'supplier_name',
  'supplier_vat_id',
  'invoice_number',
  'invoice_date',
  'amount_before_vat',
  'vat_amount',
  'total_amount',
  'expense_category',
  'allocation_number',
  'bank_name',
  'bank_branch_code',
  'bank_branch_name',
  'bank_account',
] as const;

export type ExampleField = (typeof EXAMPLE_FIELDS)[number];

/** Not shown when the example invoice belongs to another client. */
export const SENSITIVE_FIELDS: readonly ExampleField[] = [
  'bank_name',
  'bank_branch_code',
  'bank_branch_name',
  'bank_account',
];

export type ExampleValue = string | number;

/** A human-reviewed invoice row as loaded from the DB. */
export interface FewShotSourceInvoice {
  id: string;
  client_id: string | null;
  reviewed_at: string | null;
  ocr_text: string | null;
  validated_data: Partial<ExtractedData> | null;
}

/** A row of invoice_corrections (what the AI read vs. what the reviewer saved). */
export interface FewShotCorrection {
  invoice_id: string;
  field: string;
  ai_value: unknown;
  corrected_value: unknown;
}

export interface MisreadField {
  field: ExampleField;
  aiValue: ExampleValue | null;
  correctValue: ExampleValue | null;
}

export interface FewShotExample {
  invoiceId: string;
  sameClient: boolean;
  ocrText: string;
  expected: Partial<Record<ExampleField, ExampleValue>>;
  misread: MisreadField[];
}

export interface FewShotSelection {
  supplierVatId: string;
  invoices: { invoice: FewShotSourceInvoice; sameClient: boolean }[];
}

/**
 * VAT-id candidates in OCR text: standalone runs of 8-9 digits (hyphens allowed, e.g. 51-234567-8)
 * that pass the Israeli checksum. Returned normalized to 9 digits, in order of first appearance.
 */
export function findVatIdCandidates(ocrText: string | null | undefined, max = FEWSHOT_MAX_CANDIDATES): string[] {
  if (!ocrText) return [];
  const found: string[] = [];
  // Digit groups joined by single hyphens, not glued to other digits/hyphens (avoids slicing longer numbers).
  const pattern = /(?<![\d-])\d+(?:-\d+)*(?![\d-])/g;
  for (const match of ocrText.matchAll(pattern)) {
    const digits = match[0].replace(/-/g, '');
    if (digits.length !== 8 && digits.length !== 9) continue;
    if (!isValidVatIdChecksum(digits)) continue;
    const normalized = normalizeVatId(digits);
    if (normalized && !found.includes(normalized)) found.push(normalized);
    if (found.length >= max) break;
  }
  return found;
}

/** Spellings a stored supplier_vat_id may have for each candidate (9 digits, or 8 without the leading zero). */
export function vatIdQueryVariants(candidates: string[]): string[] {
  const variants = new Set<string>();
  for (const c of candidates) {
    variants.add(c);
    if (c.length === 9 && c.startsWith('0')) variants.add(c.slice(1));
  }
  return [...variants];
}

function byReviewedAtDesc(a: FewShotSourceInvoice, b: FewShotSourceInvoice): number {
  return (b.reviewed_at ?? '').localeCompare(a.reviewed_at ?? '');
}

/**
 * Picks the supplier and up to `maxExamples` of its reviewed invoices.
 * Supplier choice: most same-client invoices, then most invoices overall, then the candidate
 * that appears first in the OCR text. Same-client invoices come first, newest first; other
 * clients only fill the remaining slots.
 */
export function selectFewShotInvoices(params: {
  candidates: string[];
  tenantId: string;
  currentInvoiceId: string;
  rows: FewShotSourceInvoice[];
  maxExamples?: number;
}): FewShotSelection | null {
  const { candidates, tenantId, currentInvoiceId, rows } = params;
  const maxExamples = params.maxExamples ?? FEWSHOT_MAX_EXAMPLES;
  if (candidates.length === 0 || maxExamples <= 0) return null;

  const bySupplier = new Map<string, FewShotSourceInvoice[]>();
  const seenIds = new Set<string>();
  for (const row of rows) {
    if (!row || row.id === currentInvoiceId || seenIds.has(row.id)) continue;
    if (!row.reviewed_at || !row.validated_data || !row.ocr_text?.trim()) continue;
    const vat = normalizeVatId(row.validated_data.supplier_vat_id ?? null);
    if (!vat || !candidates.includes(vat)) continue;
    seenIds.add(row.id);
    bySupplier.set(vat, [...(bySupplier.get(vat) ?? []), row]);
  }
  if (bySupplier.size === 0) return null;

  const ranked = [...bySupplier.entries()]
    .map(([vat, list]) => ({
      vat,
      list,
      sameClient: list.filter((r) => r.client_id === tenantId).length,
      position: candidates.indexOf(vat),
    }))
    .sort((a, b) => b.sameClient - a.sameClient || b.list.length - a.list.length || a.position - b.position);
  const best = ranked[0];

  const same = best.list.filter((r) => r.client_id === tenantId).sort(byReviewedAtDesc);
  const other = best.list.filter((r) => r.client_id !== tenantId).sort(byReviewedAtDesc);

  const picked: FewShotSelection['invoices'] = [];
  const seenTexts = new Set<string>();
  for (const [list, sameClient] of [[same, true], [other, false]] as const) {
    for (const invoice of list) {
      if (picked.length >= maxExamples) break;
      // The same document uploaded twice teaches nothing new
      const key = invoice.ocr_text!.trim();
      if (seenTexts.has(key)) continue;
      seenTexts.add(key);
      picked.push({ invoice, sameClient });
    }
  }
  return { supplierVatId: best.vat, invoices: picked };
}

/** Caps OCR text, keeping the head (supplier/header) and the tail (totals), with a marker in between. */
export function truncateOcrText(text: string, cap = FEWSHOT_OCR_CHAR_CAP): string {
  const clean = text.trim();
  if (clean.length <= cap) return clean;
  const marker = '\n…[קוצר]…\n';
  const room = Math.max(0, cap - marker.length);
  const head = Math.ceil(room * 0.65);
  const tail = room - head;
  return clean.slice(0, head) + marker + (tail > 0 ? clean.slice(clean.length - tail) : '');
}

/** Removes the bank account (in any digit grouping) and IBANs from another client's OCR text. */
export function redactSensitiveText(text: string, data: Partial<ExtractedData> | null): string {
  let out = text.replace(/\bIL\s?\d{2}(?:[\s-]?\d){15,21}\b/gi, '[הוסר]');
  const account = (data?.bank_account ?? '').replace(/\D/g, '');
  if (account.length >= 4) {
    const flexible = account.split('').join('[\\s-]?');
    out = out.replace(new RegExp(`(?<!\\d)${flexible}(?!\\d)`, 'g'), '[הוסר]');
  }
  return out;
}

function toExampleValue(value: unknown): ExampleValue | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const s = String(value).trim();
  if (!s) return null;
  return s.length > MAX_VALUE_CHARS ? s.slice(0, MAX_VALUE_CHARS) : s;
}

function isExampleField(field: string): field is ExampleField {
  return (EXAMPLE_FIELDS as readonly string[]).includes(field);
}

/** Turns selected invoices + their corrections into prompt-ready examples. */
export function buildFewShotExamples(
  selection: FewShotSelection,
  corrections: FewShotCorrection[],
  ocrCharCap = FEWSHOT_OCR_CHAR_CAP
): FewShotExample[] {
  return selection.invoices.map(({ invoice, sameClient }) => {
    const allowed = (field: ExampleField) => sameClient || !SENSITIVE_FIELDS.includes(field);
    const data = invoice.validated_data ?? {};

    const expected: FewShotExample['expected'] = {};
    for (const field of EXAMPLE_FIELDS) {
      if (!allowed(field)) continue;
      const value = toExampleValue(data[field]);
      if (value !== null) expected[field] = value;
    }

    const misread: MisreadField[] = [];
    for (const c of corrections) {
      if (c.invoice_id !== invoice.id || !isExampleField(c.field) || !allowed(c.field)) continue;
      if (misread.some((m) => m.field === c.field)) continue;
      misread.push({
        field: c.field,
        aiValue: toExampleValue(c.ai_value),
        correctValue: expected[c.field] ?? toExampleValue(c.corrected_value),
      });
    }

    const rawText = invoice.ocr_text ?? '';
    const text = sameClient ? rawText : redactSensitiveText(rawText, data);
    return { invoiceId: invoice.id, sameClient, ocrText: truncateOcrText(text, ocrCharCap), expected, misread };
  });
}

function quote(value: ExampleValue | null): string {
  if (value === null) return 'ריק';
  return typeof value === 'number' ? String(value) : `"${value}"`;
}

function formatExample(example: FewShotExample, index: number): string {
  const lines = [
    `<example index="${index}">`,
    '<ocr_text>',
    example.ocrText,
    '</ocr_text>',
    '<expected_tool_input>',
    JSON.stringify(example.expected, null, 1),
    '</expected_tool_input>',
  ];
  if (example.misread.length > 0) {
    lines.push('<previously_misread>');
    for (const m of example.misread) {
      lines.push(`- ${m.field}: חולץ בטעות ${quote(m.aiValue)}, הערך הנכון ${quote(m.correctValue)}`);
    }
    lines.push('</previously_misread>');
  }
  lines.push('</example>');
  return lines.join('\n');
}

/**
 * Prompt block for the examples, or '' when there are none. Examples that would push the block
 * over `budget` characters are dropped; `usedInvoiceIds` lists the ones actually included.
 */
export function formatFewShotPrompt(
  examples: FewShotExample[],
  supplierVatId: string | null,
  budget = FEWSHOT_TOTAL_CHAR_BUDGET
): { text: string; usedInvoiceIds: string[] } {
  if (examples.length === 0) return { text: '', usedInvoiceIds: [] };

  const header = [
    `דוגמאות מחשבוניות קודמות של אותו ספק${supplierVatId ? ` (ח.פ. ${supplierVatId})` : ''} שנבדקו ואושרו ידנית.`,
    'השתמש בהן כדי להבין את מבנה המסמכים של הספק — היכן מופיע כל שדה ואיך לקרוא אותו.',
    'הערכים בדוגמאות שייכים לחשבוניות הקודמות בלבד: אל תעתיק מהן ערכים, חלץ את הנתונים רק מהחשבונית הנוכחית.',
    'שדות תחת previously_misread חולצו בעבר בטעות מהספק הזה — הקדש להם תשומת לב מיוחדת.',
  ].join('\n');

  const parts: string[] = [];
  const usedInvoiceIds: string[] = [];
  let length = header.length;
  for (const example of examples) {
    const block = formatExample(example, parts.length + 1);
    if (length + block.length + 2 > budget) break;
    parts.push(block);
    usedInvoiceIds.push(example.invoiceId);
    length += block.length + 2;
  }
  if (parts.length === 0) return { text: '', usedInvoiceIds: [] };
  return { text: `${header}\n\n${parts.join('\n\n')}`, usedInvoiceIds };
}
