// Learning from reviewer corrections (pure logic; DB access lives in src/lib/learning.ts).
//
// When a reviewer corrects a field and the correct value is printed in the document (found in the
// OCR text), the correction is a "learning signal": for this supplier, the field is the value next
// to a given label ("אסמכתא", "חשבונית מס / קבלה מס'"...), not the one the model picked. Signals of
// the same office + client + supplier + field are aggregated into a rule. Active rules are:
//   1. shown to the model as hints in the next extraction of that supplier, and
//   2. applied deterministically after extraction (the value next to the learned label replaces
//      the model's value when exactly one value of the learned shape is found there).
// Values that are not in the document (category, ledger account, a typo) never create a rule.
import type { ExtractedData } from '@/shared/types';
import { findVatIdCandidates } from '@/shared/fewshot';
import { normalizeVatId } from '@/shared/vatId';

/** Fields a rule may be learned for (printed values whose location on the document is stable). */
export const LEARNABLE_FIELDS = [
  'invoice_number',
  'invoice_date',
  'allocation_number',
  'supplier_vat_id',
  'total_amount',
  'vat_amount',
  'amount_before_vat',
] as const;
export type LearnableField = (typeof LEARNABLE_FIELDS)[number];

export type ValueKind = 'id' | 'date' | 'amount';
export type LearningClass = 'in_document' | 'not_in_document' | 'user_typo';

/** A learned rule needs this many agreeing signals... */
export const RULE_MIN_SUPPORT = 1;
/** ...and more agreeing than disagreeing ones (a single new correction never overrides an established rule). */
export const RULE_MAX_SIGNALS = 50;
/** Labels shorter than this (letters) are too generic to anchor a value. */
const MIN_LABEL_LETTERS = 3;
const MAX_LABEL_CHARS = 60;

export function isLearnableField(field: string): field is LearnableField {
  return (LEARNABLE_FIELDS as readonly string[]).includes(field);
}

export function valueKind(field: LearnableField): ValueKind {
  if (field === 'invoice_date') return 'date';
  if (field === 'total_amount' || field === 'vat_amount' || field === 'amount_before_vat') return 'amount';
  return 'id';
}

// ── Normalization ────────────────────────────────────────────────────────────

/** Identifier comparison key: no spaces or hyphens, upper case. Leading zeros are kept ('05891' ≠ '5891'). */
export function normalizeIdentifier(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).replace(/[\s‎‏-]/g, '').toUpperCase();
  return s === '' ? null : s;
}

/** Amount as a number rounded to agorot ('1,234.50', 1234.5 → 1234.5). */
export function normalizeAmount(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
  const s = String(value).trim().replace(/[₪\s]/g, '').replace(/,(?=\d{3}(\D|$))/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

/** A date as YYYY-MM-DD: ISO input, or Israeli day/month/year with / . - separators (2-digit years = 20xx). */
export function normalizeDate(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  let y: number, m: number, d: number;
  let match = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (match) {
    [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else {
    match = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/);
    if (!match) return null;
    [d, m, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
    if (y < 100) y += 2000;
  }
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1990 || y > 2100) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Comparable form of a value of the given kind (string for id/date, number for amounts). */
export function normalizeValue(kind: ValueKind, value: unknown): string | number | null {
  if (kind === 'amount') return normalizeAmount(value);
  if (kind === 'date') return normalizeDate(value);
  return normalizeIdentifier(value);
}

/** Label text: letters and spaces only (quotes, geresh, punctuation and numbers dropped), lower case. */
export function normalizeLabel(text: string): string {
  return text
    .replace(/\S*\d\S*/g, ' ')
    .replace(/[^\p{L}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, MAX_LABEL_CHARS)
    .trim();
}

function letterCount(s: string): number {
  return (s.match(/\p{L}/gu) ?? []).length;
}

/** Supplier name key: no quotes / punctuation, single spaces (Hebrew kept as is). */
export function normalizeSupplierName(name: unknown): string | null {
  if (name === null || name === undefined) return null;
  const s = String(name).replace(/["'״׳`.,]/g, '').replace(/\s+/g, ' ').trim();
  return s === '' ? null : s;
}

/** Key of a supplier: VAT id when known (9 digits), otherwise the normalized name. */
export function supplierKey(vatId: unknown, name: unknown): string | null {
  const vat = normalizeVatId(typeof vatId === 'string' ? vatId : vatId == null ? null : String(vatId));
  if (vat && vat.length === 9) return `vat:${vat}`;
  const n = normalizeSupplierName(name);
  return n ? `name:${n}` : null;
}

// ── Tokens on OCR lines ──────────────────────────────────────────────────────

export interface Token {
  raw: string;
  value: string | number;
}

const ID_TOKEN = /[\p{L}\d](?:[\p{L}\d/.-]*[\p{L}\d])?/gu;
const DATE_TOKEN = /(?<![\d/.-])(?:\d{1,2}[/.-]\d{1,2}[/.-](?:\d{4}|\d{2})|\d{4}-\d{1,2}-\d{1,2})(?![\d/.-])/g;
const AMOUNT_TOKEN = /(?<![\d.,])-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?(?![\d])/g;

/** Values of the given kind on one OCR line, left to right. */
export function tokensOf(kind: ValueKind, line: string): Token[] {
  const out: Token[] = [];
  if (kind === 'id') {
    for (const m of line.matchAll(ID_TOKEN)) {
      if (!/\d/.test(m[0])) continue;
      const v = normalizeIdentifier(m[0]);
      if (v) out.push({ raw: m[0], value: v });
    }
  } else if (kind === 'date') {
    for (const m of line.matchAll(DATE_TOKEN)) {
      const v = normalizeDate(m[0]);
      if (v) out.push({ raw: m[0], value: v });
    }
  } else {
    // A date's parts are not amounts
    const withoutDates = line.replace(DATE_TOKEN, ' ');
    for (const m of withoutDates.matchAll(AMOUNT_TOKEN)) {
      const v = normalizeAmount(m[0]);
      if (v !== null) out.push({ raw: m[0], value: v });
    }
  }
  return out;
}

/** Shape of a learned value: candidates on the label's line must look alike. */
export interface ValueShape {
  kind: ValueKind;
  /** Identifier length (characters, normalized). */
  length?: number;
  /** Identifier made of digits only. */
  digitsOnly?: boolean;
  /** Position among the compatible values of its line, counted from the end (0 = last). */
  positionFromEnd?: number;
}

function compatible(shape: ValueShape, token: Token): boolean {
  if (shape.kind !== 'id') return true;
  const v = String(token.value);
  if (shape.digitsOnly !== undefined && /^\d+$/.test(v) !== shape.digitsOnly) return false;
  if (shape.length !== undefined && Math.abs(v.length - shape.length) > 1) return false;
  return true;
}

function sameValue(kind: ValueKind, a: string | number | null, b: string | number | null): boolean {
  if (a === null || b === null) return false;
  if (kind === 'amount') return Math.abs(Number(a) - Number(b)) < 0.005;
  return a === b;
}

export interface ValueLocation {
  lineIndex: number;
  /** Label of the value: the text of its line, or of the line above when its own line has none. */
  label: string | null;
  /** 0 = label on the value's line, 1 = label on the line above. */
  lineOffset: 0 | 1;
  shape: ValueShape;
}

function splitLines(ocrText: string): string[] {
  return ocrText.split(/\r?\n/);
}

/** Where a value is printed in the OCR text (first occurrence), with the label next to it. */
export function locateValue(kind: ValueKind, value: unknown, ocrText: string | null | undefined): ValueLocation | null {
  if (!ocrText) return null;
  const target = normalizeValue(kind, value);
  if (target === null) return null;
  const lines = splitLines(ocrText);
  for (let i = 0; i < lines.length; i++) {
    const tokens = tokensOf(kind, lines[i]);
    const index = tokens.findIndex((t) => sameValue(kind, t.value, target));
    if (index < 0) continue;
    const self = tokens[index];
    const shape: ValueShape = { kind };
    if (kind === 'id') {
      shape.length = String(self.value).length;
      shape.digitsOnly = /^\d+$/.test(String(self.value));
    }
    const peers = tokens.filter((t) => compatible(shape, t));
    shape.positionFromEnd = peers.length - 1 - peers.indexOf(self);

    let label: string | null = normalizeLabel(lines[i]);
    let lineOffset: 0 | 1 = 0;
    if (letterCount(label) < MIN_LABEL_LETTERS) {
      const above = i > 0 ? normalizeLabel(lines[i - 1]) : '';
      if (letterCount(above) >= MIN_LABEL_LETTERS && tokensOf(kind, lines[i - 1]).filter((t) => compatible(shape, t)).length === 0) {
        label = above;
        lineOffset = 1;
      } else {
        label = null;
      }
    }
    return { lineIndex: i, label, lineOffset, shape };
  }
  return null;
}

/** Same as locateValue for identifiers glued differently in the OCR ('3 0941' read as '30941'). */
function locateLoosely(kind: ValueKind, value: unknown, ocrText: string): { label: string | null } | null {
  const exact = locateValue(kind, value, ocrText);
  if (exact) return exact;
  if (kind !== 'id') return null;
  const target = normalizeIdentifier(value);
  if (!target || target.length < 3) return null;
  for (const line of splitLines(ocrText)) {
    if (line.replace(/[\s-]/g, '').toUpperCase().includes(target)) {
      const label = normalizeLabel(line);
      return { label: letterCount(label) >= MIN_LABEL_LETTERS ? label : null };
    }
  }
  return null;
}

// ── Classification ───────────────────────────────────────────────────────────

export interface Classification {
  field: string;
  classification: LearningClass;
  /** Why (Hebrew-free code, for logs / the API answer). */
  reason: string;
  label: string | null;
  wrongLabel: string | null;
  lineOffset: 0 | 1 | null;
  shape: ValueShape | null;
}

function editDistanceAtMostOne(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) {
    const diff = [...a].map((c, i) => (c !== b[i] ? i : -1)).filter((i) => i >= 0);
    if (diff.length === 1) return true;
    // Two neighbouring characters swapped
    return diff.length === 2 && diff[1] === diff[0] + 1 && a[diff[0]] === b[diff[1]] && a[diff[1]] === b[diff[0]];
  }
  const [s, l] = a.length < b.length ? [a, b] : [b, a];
  for (let i = 0; i < l.length; i++) if (l.slice(0, i) + l.slice(i + 1) === s) return true;
  return false;
}

/**
 * Classifies one corrected field:
 * - in_document: the corrected value (normalized) is printed in the OCR text;
 * - user_typo: it is not, but a printed value of the same kind differs from it by one character
 *   (or two swapped ones), i.e. the reviewer most likely mistyped a printed value;
 * - not_in_document: anything else (category, ledger account, cleared field, a value from elsewhere).
 */
export function classifyCorrection(
  field: string,
  aiValue: unknown,
  correctedValue: unknown,
  ocrText: string | null | undefined
): Classification {
  const base = { field, label: null, wrongLabel: null, lineOffset: null, shape: null };
  if (!isLearnableField(field)) return { ...base, classification: 'not_in_document', reason: 'field_not_printed' };
  const kind = valueKind(field);
  const corrected = normalizeValue(kind, correctedValue);
  if (corrected === null) return { ...base, classification: 'not_in_document', reason: 'cleared' };
  if (!ocrText?.trim()) return { ...base, classification: 'not_in_document', reason: 'no_ocr_text' };

  const location = locateValue(kind, correctedValue, ocrText);
  if (location) {
    const wrong = aiValue === null || aiValue === undefined ? null : locateLoosely(kind, aiValue, ocrText);
    const wrongLabel = wrong?.label && wrong.label !== location.label ? wrong.label : null;
    return {
      field,
      classification: 'in_document',
      reason: location.label ? 'found' : 'found_without_label',
      label: location.label,
      wrongLabel,
      lineOffset: location.label ? location.lineOffset : null,
      shape: location.shape,
    };
  }

  if (kind !== 'date') {
    const typed = String(corrected);
    if (typed.replace(/\D/g, '').length >= 4) {
      const near = splitLines(ocrText).some((line) =>
        tokensOf(kind, line).some((t) => editDistanceAtMostOne(String(t.value), typed))
      );
      if (near) return { ...base, classification: 'user_typo', reason: 'one_char_from_printed_value' };
    }
  }
  return { ...base, classification: 'not_in_document', reason: 'not_found' };
}

// ── Aggregation into a rule ──────────────────────────────────────────────────

export interface LearningSignal {
  label: string | null;
  wrong_label?: string | null;
  line_offset?: number | null;
  value_shape?: ValueShape | null;
  corrected_value?: string | null;
  ai_value?: string | null;
  created_at?: string | null;
}

export interface RuleDecision {
  label: string;
  wrong_label: string | null;
  line_offset: 0 | 1;
  value_shape: ValueShape;
  support: number;
  conflicts: number;
  active: boolean;
  last_value: string | null;
  last_wrong_value: string | null;
}

/**
 * The rule the in-document signals of one office + client + supplier + field support.
 * The most supported label wins; on a tie the existing rule's label stays (a single new correction
 * never overrides an established rule). The rule is active only while it has more agreeing than
 * disagreeing signals. Returns null when no signal carries a label (nothing to anchor a rule to).
 */
export function decideRule(signals: LearningSignal[], incumbentLabel: string | null = null): RuleDecision | null {
  const usable = signals.filter((s) => s.label && s.value_shape).slice(0, RULE_MAX_SIGNALS);
  if (usable.length === 0) return null;
  const newestFirst = [...usable].sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));
  const groups = new Map<string, LearningSignal[]>();
  for (const s of newestFirst) groups.set(s.label!, [...(groups.get(s.label!) ?? []), s]);

  const ranked = [...groups.entries()].sort(
    (a, b) =>
      b[1].length - a[1].length ||
      Number(b[0] === incumbentLabel) - Number(a[0] === incumbentLabel) ||
      (b[1][0].created_at ?? '').localeCompare(a[1][0].created_at ?? '')
  );
  const [label, winners] = ranked[0];
  const support = winners.length;
  const conflicts = usable.length - support;
  const latest = winners[0];
  return {
    label,
    wrong_label: winners.find((s) => s.wrong_label)?.wrong_label ?? null,
    line_offset: latest.line_offset === 1 ? 1 : 0,
    value_shape: latest.value_shape!,
    support,
    conflicts,
    active: support >= RULE_MIN_SUPPORT && support > conflicts,
    last_value: latest.corrected_value ?? null,
    last_wrong_value: latest.ai_value ?? null,
  };
}

// ── Applying rules to a new extraction ───────────────────────────────────────

/** A learned rule as loaded for an extraction (also stored in the processing queue's state). */
export interface LearnedRule {
  id: string;
  client_id: string;
  supplier_key: string;
  supplier_vat_id: string | null;
  supplier_name: string | null;
  field: LearnableField;
  label: string;
  wrong_label: string | null;
  line_offset: number;
  value_shape: ValueShape;
  support: number;
  conflicts: number;
  active: boolean;
  last_value: string | null;
  last_wrong_value: string | null;
}

export interface LearnedApplication {
  rule_id: string;
  field: LearnableField;
  from: string | number | null;
  to: string | number;
  label: string;
}

export interface LearnedRulesTrace {
  applied: LearnedApplication[];
  applied_at: string;
}

/**
 * Rules that may apply to this document: active, and of a supplier whose VAT id is printed in it
 * (or, for rules keyed by name, whose name is). One rule per field: the client's own rule first,
 * then the office's best supported one.
 */
export function selectRulesForDocument(rules: LearnedRule[], clientId: string, ocrText: string | null | undefined): LearnedRule[] {
  if (!ocrText) return [];
  const candidates = new Set(findVatIdCandidates(ocrText, 100));
  const text = normalizeSupplierName(ocrText) ?? '';
  const matches = rules.filter((r) => {
    if (!r.active || !isLearnableField(r.field)) return false;
    if (r.supplier_key.startsWith('vat:')) return candidates.has(r.supplier_key.slice(4));
    const name = r.supplier_key.slice(5);
    return name.length >= 3 && text.includes(name);
  });
  const byField = new Map<string, LearnedRule>();
  const sorted = [...matches].sort(
    (a, b) => Number(b.client_id === clientId) - Number(a.client_id === clientId) || b.support - a.support
  );
  for (const r of sorted) if (!byField.has(r.field)) byField.set(r.field, r);
  return [...byField.values()];
}

/** The value next to the rule's label in this document, when exactly one fits the learned shape. */
export function valueByRule(rule: Pick<LearnedRule, 'field' | 'label' | 'line_offset' | 'value_shape'>, ocrText: string): string | number | null {
  if (!isLearnableField(rule.field) || letterCount(rule.label) < MIN_LABEL_LETTERS) return null;
  const kind = valueKind(rule.field);
  const shape: ValueShape = { ...rule.value_shape, kind };
  const lines = splitLines(ocrText);
  const found = new Set<string | number>();
  for (let i = 0; i < lines.length; i++) {
    if (!normalizeLabel(lines[i]).includes(rule.label)) continue;
    const valueLine = lines[i + (rule.line_offset === 1 ? 1 : 0)];
    if (valueLine === undefined) continue;
    const peers = tokensOf(kind, valueLine).filter((t) => compatible(shape, t));
    if (peers.length === 0) continue;
    const pos = shape.positionFromEnd ?? 0;
    const pick = peers.length === 1 ? peers[0] : pos < peers.length ? peers[peers.length - 1 - pos] : null;
    if (pick) found.add(pick.value);
  }
  // Two different values next to the label: not sure which one - leave the model's value
  return found.size === 1 ? [...found][0] : null;
}

function amountsConsistent(data: Partial<ExtractedData>): boolean {
  const total = normalizeAmount(data.total_amount);
  const vat = normalizeAmount(data.vat_amount);
  const before = normalizeAmount(data.amount_before_vat);
  if (total === null || vat === null || before === null) return true;
  return Math.abs(before + vat - total) <= 1;
}

/**
 * Applies learned rules to a new extraction (never mutates `data`). A rule replaces the model's
 * value only when the learned label is found and exactly one value of the learned shape is next to
 * it; an amount is replaced only if the sums still add up. Replaced fields get a high confidence and
 * lose their (model) bbox; the trace is kept in `learned_rules`.
 */
export function applyLearnedRules(
  data: ExtractedData,
  rules: LearnedRule[] | null | undefined,
  ocrText: string | null | undefined,
  now: string = new Date().toISOString()
): { data: ExtractedData; applied: LearnedApplication[] } {
  if (!rules || rules.length === 0 || !ocrText) return { data, applied: [] };
  const next: ExtractedData = { ...data };
  const applied: LearnedApplication[] = [];
  const extractedVat = normalizeVatId(data.supplier_vat_id ?? null);

  for (const rule of rules) {
    if (!rule.active || !isLearnableField(rule.field)) continue;
    // The model named another supplier: this supplier's layout says nothing about it
    if (rule.field !== 'supplier_vat_id' && rule.supplier_vat_id && extractedVat && extractedVat !== normalizeVatId(rule.supplier_vat_id)) continue;
    const kind = valueKind(rule.field);
    const value = valueByRule(rule, ocrText);
    if (value === null) continue;
    const current = normalizeValue(kind, (next as unknown as Record<string, unknown>)[rule.field]);
    if (sameValue(kind, current, value)) continue;

    const candidate: ExtractedData = { ...next, [rule.field]: kind === 'amount' ? Number(value) : String(value) };
    if (kind === 'amount' && !amountsConsistent(candidate)) continue;
    Object.assign(next, { [rule.field]: candidate[rule.field as keyof ExtractedData] });
    applied.push({ rule_id: rule.id, field: rule.field, from: current, to: value, label: rule.label });
  }
  if (applied.length === 0) return { data, applied };

  const fields = applied.map((a) => a.field as string);
  next.field_confidence = { ...(data.field_confidence ?? {}) };
  for (const f of fields) (next.field_confidence as Record<string, number>)[f] = 0.9;
  if (data.bboxes) {
    next.bboxes = Object.fromEntries(Object.entries(data.bboxes).filter(([f]) => !fields.includes(f)));
  }
  next.learned_rules = { applied, applied_at: now };
  return { data: next, applied };
}

const FIELD_NAMES_HE: Record<LearnableField, string> = {
  invoice_number: 'מספר חשבונית',
  invoice_date: 'תאריך החשבונית',
  allocation_number: 'מספר הקצאה',
  supplier_vat_id: 'ח.פ. הספק',
  total_amount: 'סה"כ לתשלום',
  vat_amount: 'סכום המע"מ',
  amount_before_vat: 'סכום לפני מע"מ',
};

export function learnableFieldName(field: string): string {
  return isLearnableField(field) ? FIELD_NAMES_HE[field] : field;
}

/** Prompt block with the learned rules of this supplier, or '' when there are none. */
export function formatLearnedHints(rules: LearnedRule[] | null | undefined): string {
  const active = (rules ?? []).filter((r) => r.active && isLearnableField(r.field));
  if (active.length === 0) return '';
  const lines = active.map((r) => {
    const where = r.line_offset === 1 ? `בשורה שמתחת ל-"${r.label}"` : `ליד "${r.label}"`;
    const not = r.wrong_label ? ` ולא ליד "${r.wrong_label}"` : '';
    const was = r.last_wrong_value ? ` (בעבר חולץ בטעות ${r.last_wrong_value})` : '';
    return `- ${r.field} (${FIELD_NAMES_HE[r.field]}): הערך שמופיע ${where}${not}${was}.`;
  });
  return [
    'כללים שנלמדו מתיקונים ידניים בחשבוניות קודמות של ספק זה (הם מתארים היכן מופיע השדה, לא את ערכו):',
    ...lines,
  ].join('\n');
}
