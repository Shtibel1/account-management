// The supplier's VAT ID is the issuer's (seller's) ח.פ. / עוסק מורשה. Invoices also print the
// buyer's ID in the customer block ("לכבוד", "ח.פ לקוח"), and the model sometimes takes that one.
// These helpers find each ID's label context so validation can swap or flag it. Two sources:
// - the OCR text, where a label and its number share a line;
// - the OCR word boxes, for key/value tables where the label column and the value column are
//   separate OCR blocks (so the text puts them on different lines), and for scans that are
//   upside down or sideways.
import type { OcrWord } from '@/shared/types';
import { isValidVatIdChecksum, normalizeVatId } from '@/shared/vatId';

/** Labels of the buyer / customer block. "לקוחות" (as in "שירות לקוחות") is not a buyer label. */
const BUYER_LABEL = /לכבוד|לקוח(?!ות)|נמען|מזמין|(?<![֐-׿])קונה(?![֐-׿])/;

/** Labels of an ID of the issuing business ("ח.פ:", "ע.מ", "עוסק מורשה"). Checked only when no buyer label is near. */
const ISSUER_LABEL = /ח\s*[."״'׳]\s*פ|ע\s*[."״'׳]\s*מ(?![֐-׿])|עוסק|מורשה/;

/**
 * Labels of numbers that are not a business ID at all but often pass the checksum by chance:
 * transaction / reference / order / invoice / account / phone numbers ("מספר עסקה 311057368").
 */
const OTHER_LABEL =
  /עסקה|אסמכת|אסמ\s*['׳"״]|הזמנ|חשבון|קבלה|טלפון|(?<![֐-׿])טל(?![֐-׿])|פקס|נייד|סלולר|הקצאה|שובר|משלוח|מנוי|פוליסה|כרטיס|סניף|בנק|ברקוד|מק\s*["״]?\s*ט|רכב|רישוי|ניכוי|(?<![֐-׿])תיק(?![֐-׿])|אישור|הפני|תשלום|(?<![a-z])(?:tel|phone|fax|order|ref|invoice|receipt|account|transaction)(?![a-z])/i;

/** Characters on each side of the number that count as "next to" a label (same line only). */
const CONTEXT_CHARS = 28;

/** Digit groups joined by single hyphens / spaces inside a number (e.g. 51-180380-5), not glued to other digits. */
const NUMBER_PATTERN = /(?<![\d-])\d+(?:[- ]\d+)*(?![\d-])/g;

export interface VatIdOccurrence {
  vatId: string;
  /** True when a buyer label sits next to the number (same line, or the header of its table cell). */
  buyerLabelled: boolean;
  /**
   * True when an issuer label ("ח.פ", "עוסק מורשה") and no buyer label sits next to the number, and
   * no other label ("מספר עסקה", "אסמכתא", "טלפון" …) sits closer to it.
   */
  issuerLabelled: boolean;
}

function labelFlags(context: string): { buyerLabelled: boolean; issuerLabelled: boolean } {
  const buyerLabelled = BUYER_LABEL.test(context);
  return { buyerLabelled, issuerLabelled: !buyerLabelled && ISSUER_LABEL.test(context) && !OTHER_LABEL.test(context) };
}

function globalRegex(re: RegExp): RegExp {
  return new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
}

/** Characters between the end of the last label match in `before` and the number (null = none). */
function distanceBefore(re: RegExp, before: string): number | null {
  let end: number | null = null;
  for (const m of before.matchAll(globalRegex(re))) end = (m.index ?? 0) + m[0].length;
  return end == null ? null : before.length - end;
}

/** Characters between the number and the first label match in `after` (null = none). */
function distanceAfter(re: RegExp, after: string): number | null {
  const m = globalRegex(re).exec(after);
  return m ? m.index : null;
}

/**
 * Issuer label of a number in the OCR text: the label written right before it (Hebrew OCR text is
 * in logical order: "ח.פ: 511863805"), or, when nothing labels it from before, the one right after
 * it (reversed / mixed-direction lines). The nearest label on that side decides, so in
 * "מספר עסקה 311057368" the transaction number is not taken for an ID because a "ח.פ" follows it.
 */
function isIssuerLabelledInText(before: string, after: string): boolean {
  for (const [issuer, other] of [
    [distanceBefore(ISSUER_LABEL, before), distanceBefore(OTHER_LABEL, before)],
    [distanceAfter(ISSUER_LABEL, after), distanceAfter(OTHER_LABEL, after)],
  ]) {
    if (issuer == null && other == null) continue;
    return issuer != null && (other == null || issuer <= other);
  }
  return false;
}

/** Every 8/9-digit number in the OCR text (normalized to 9 digits), with its label context. */
export function findVatIdOccurrences(ocrText: string | null | undefined): VatIdOccurrence[] {
  if (!ocrText) return [];
  const result: VatIdOccurrence[] = [];
  for (const line of ocrText.split(/\r?\n/)) {
    for (const match of line.matchAll(NUMBER_PATTERN)) {
      // A spaced run can glue a phone number to the ID; try the whole run and its groups
      const pieces = [match[0], ...match[0].split(' ')];
      const seen = new Set<string>();
      for (const piece of pieces) {
        const digits = piece.replace(/[- ]/g, '');
        if (digits.length !== 8 && digits.length !== 9) continue;
        const vatId = normalizeVatId(digits);
        if (!vatId || seen.has(vatId)) continue;
        seen.add(vatId);
        const start = match.index ?? 0;
        const before = line.slice(Math.max(0, start - CONTEXT_CHARS), start);
        const after = line.slice(start + match[0].length, start + match[0].length + CONTEXT_CHARS);
        const buyer = BUYER_LABEL.test(before) || BUYER_LABEL.test(after);
        result.push({
          vatId,
          buyerLabelled: buyer,
          issuerLabelled: !buyer && isIssuerLabelledInText(before, after),
        });
      }
    }
  }
  return result;
}

// ─── Word-position analysis ────────────────────────────────────────────────────

/** A word box in reading-axis coordinates: `u` runs along the text line, `v` across lines. */
interface AxisWord {
  text: string;
  page: number;
  u1: number;
  u2: number;
  v1: number;
  v2: number;
  /** Index in the OCR word order (Vision's reading order within a paragraph). */
  index: number;
}

/** Words on the same line as a number, at most this far away along the line (fraction of the page). */
const MAX_LINE_GAP = 0.3;
/** Words of label context taken on each side of a number. */
const LABEL_WORDS_PER_SIDE = 3;
/** A stand-alone number takes the label of a header at most this many line heights above / below it. */
const MAX_HEADER_LINES = 2.5;

/**
 * Vision returns word boxes in image coordinates. On a page scanned sideways the text lines run
 * vertically; multi-letter words are then taller than wide. Rotate so `u` always runs along the line
 * (a 180° page keeps horizontal lines, which is all the checks below need).
 */
function toAxisWords(words: readonly OcrWord[]): AxisWord[] {
  const long = words.filter((w) => w.text.length >= 4);
  const sideways = long.filter((w) => w.bbox.y2 - w.bbox.y1 > w.bbox.x2 - w.bbox.x1).length;
  const vertical = long.length > 0 && sideways > long.length / 2;
  return words.map((w, index) => {
    const { x1, y1, x2, y2 } = w.bbox;
    return vertical
      ? { text: w.text, page: w.page, u1: y1, u2: y2, v1: x1, v2: x2, index }
      : { text: w.text, page: w.page, u1: x1, u2: x2, v1: y1, v2: y2, index };
  });
}

function sameLine(a: AxisWord, b: AxisWord): boolean {
  if (a.page !== b.page) return false;
  const overlap = Math.min(a.v2, b.v2) - Math.max(a.v1, b.v1);
  const minHeight = Math.min(a.v2 - a.v1, b.v2 - b.v1);
  return minHeight > 0 && overlap >= minHeight * 0.5;
}

function gapAlongLine(a: AxisWord, b: AxisWord): number {
  return Math.max(0, Math.max(a.u1, b.u1) - Math.min(a.u2, b.u2));
}

const DIGIT_PIECE = /^[\d-]+$/;
const HAS_DIGIT = /\d/;
const HAS_LETTER = /[A-Za-z֐-׿]/;

interface NumberToken {
  vatId: string;
  box: AxisWord;
  parts: Set<number>;
}

/** 8/9-digit numbers, joining the digit / hyphen words Vision splits them into ("51", "-", "1803805"). */
function numberTokens(words: AxisWord[]): NumberToken[] {
  const tokens: NumberToken[] = [];
  let i = 0;
  while (i < words.length) {
    const first = words[i];
    if (!DIGIT_PIECE.test(first.text) || !HAS_DIGIT.test(first.text)) { i++; continue; }
    const run = [first];
    let j = i + 1;
    while (j < words.length) {
      const next = words[j];
      const prev = run[run.length - 1];
      const height = prev.v2 - prev.v1;
      if (!DIGIT_PIECE.test(next.text) || !sameLine(prev, next) || gapAlongLine(prev, next) > height) break;
      run.push(next);
      j++;
    }
    const digits = run.map((w) => w.text.replace(/-/g, '')).join('');
    const vatId = digits.length === 8 || digits.length === 9 ? normalizeVatId(digits) : null;
    if (vatId) {
      tokens.push({
        vatId,
        box: {
          text: digits,
          page: first.page,
          u1: Math.min(...run.map((w) => w.u1)),
          u2: Math.max(...run.map((w) => w.u2)),
          v1: Math.min(...run.map((w) => w.v1)),
          v2: Math.max(...run.map((w) => w.v2)),
          index: first.index,
        },
        parts: new Set(run.map((w) => w.index)),
      });
    }
    i = j;
  }
  return tokens;
}

/** Up to LABEL_WORDS_PER_SIDE words on one side of the number, stopping at another number or a wide gap. */
function sideContext(token: NumberToken, lineWords: AxisWord[], side: 'start' | 'end'): AxisWord[] {
  const onSide = lineWords
    .filter((w) => (side === 'start' ? w.u2 <= token.box.u1 + 1e-6 : w.u1 >= token.box.u2 - 1e-6))
    .sort((a, b) => gapAlongLine(token.box, a) - gapAlongLine(token.box, b));
  const picked: AxisWord[] = [];
  for (const w of onSide) {
    if (gapAlongLine(token.box, w) > MAX_LINE_GAP) break;
    if (!HAS_LETTER.test(w.text) && HAS_DIGIT.test(w.text) && w.text.replace(/\D/g, '').length >= 5) break;
    picked.push(w);
    if (picked.length >= LABEL_WORDS_PER_SIDE) break;
  }
  return picked;
}

/** Text of a set of words in their visual order along the line (both directions are tried by the regexes). */
function joinWords(words: AxisWord[]): string {
  const ordered = [...words].sort((a, b) => a.u1 - b.u1);
  // Right-to-left and left-to-right orders both: a 180° scan reverses the visual order of the words
  return `${ordered.map((w) => w.text).join(' ')} | ${[...ordered].reverse().map((w) => w.text).join(' ')}`;
}

/** How many of the side's words (nearest first) it takes to reach a match of `re` (null = none). */
function wordsToLabel(re: RegExp, side: AxisWord[]): number | null {
  for (let k = 1; k <= side.length; k++) {
    if (re.test(joinWords(side.slice(0, k)))) return k;
  }
  return null;
}

/** Issuer label next to a number in the word layout: the nearest label on either side must be the issuer's. */
function isIssuerLabelledInWords(start: AxisWord[], end: AxisWord[]): boolean {
  let issuer: number | null = null;
  let other: number | null = null;
  for (const side of [start, end]) {
    const i = wordsToLabel(ISSUER_LABEL, side);
    const o = wordsToLabel(OTHER_LABEL, side);
    if (i != null && (issuer == null || i < issuer)) issuer = i;
    if (o != null && (other == null || o < other)) other = o;
  }
  return issuer != null && (other == null || issuer <= other);
}

/**
 * Every 8/9-digit number in the OCR word boxes, with its label: the words next to it on its line,
 * or, for a number alone in its cell, the header right above / below it in the same column.
 */
export function findVatIdOccurrencesFromWords(ocrWords: readonly OcrWord[] | null | undefined): VatIdOccurrence[] {
  if (!ocrWords || ocrWords.length === 0) return [];
  const words = toAxisWords(ocrWords);
  const result: VatIdOccurrence[] = [];
  for (const token of numberTokens(words)) {
    const others = words.filter((w) => !token.parts.has(w.index) && w.page === token.box.page);
    const lineWords = others.filter((w) => sameLine(token.box, w));
    const startSide = sideContext(token, lineWords, 'start');
    const endSide = sideContext(token, lineWords, 'end');
    const context = [...startSide, ...endSide];
    const buyerLabelled = BUYER_LABEL.test(joinWords(context));
    let flags = { buyerLabelled, issuerLabelled: !buyerLabelled && isIssuerLabelledInWords(startSide, endSide) };

    if (!context.some((w) => HAS_LETTER.test(w.text))) {
      // A value alone in a table cell: take the header line nearest above or below, in the same column
      const height = token.box.v2 - token.box.v1;
      const column = others.filter(
        (w) =>
          !sameLine(token.box, w) &&
          Math.min(w.u2, token.box.u2) - Math.max(w.u1, token.box.u1) > 0 &&
          Math.min(Math.abs(w.v1 - token.box.v2), Math.abs(token.box.v1 - w.v2)) <= height * MAX_HEADER_LINES
      );
      const nearest = column.sort(
        (a, b) =>
          Math.min(Math.abs(a.v1 - token.box.v2), Math.abs(token.box.v1 - a.v2)) -
          Math.min(Math.abs(b.v1 - token.box.v2), Math.abs(token.box.v1 - b.v2))
      )[0];
      if (nearest && HAS_LETTER.test(nearest.text)) {
        // The header words over this column only (padded by the number's width), not the next column's
        const pad = token.box.u2 - token.box.u1;
        const header = others.filter(
          (w) => sameLine(nearest, w) && Math.min(w.u2, token.box.u2 + pad) - Math.max(w.u1, token.box.u1 - pad) > 0
        );
        flags = labelFlags(joinWords(header));
      }
    }
    result.push({ vatId: token.vatId, ...flags });
  }
  return result;
}

// ─── Supplier VAT ID check ─────────────────────────────────────────────────────

function isBuyerLabelledIn(id: string, occurrences: VatIdOccurrence[]): boolean {
  const hits = occurrences.filter((o) => o.vatId === id);
  return hits.length > 0 && hits.every((o) => o.buyerLabelled);
}

/**
 * True when the ID appears only next to buyer labels (never in the issuer's header / footer), in the
 * OCR text or in the OCR word layout.
 */
export function isBuyerLabelledVatId(
  vatId: string | null | undefined,
  ocrText: string | null | undefined,
  ocrWords?: readonly OcrWord[] | null
): boolean {
  const id = normalizeVatId(vatId);
  if (!id) return false;
  return isBuyerLabelledIn(id, findVatIdOccurrences(ocrText)) || isBuyerLabelledIn(id, findVatIdOccurrencesFromWords(ocrWords));
}

export interface SupplierVatIdCheck {
  /** The VAT ID to keep: the original, the ID it was swapped for, or null when removed. */
  vatId: string | null;
  /**
   * Why the extracted ID is not the supplier's (null = it looks fine):
   * buyer_label - printed next to a buyer label; client_own - the client's own ID (history);
   * misread - fails the checksum, is not on the page, and the page has one clear issuer ID.
   */
  reason: 'buyer_label' | 'client_own' | 'misread' | null;
  /** The ID used instead, when one was found. */
  replacement: string | null;
  /**
   * Where the replacement comes from: issuer_label - printed on the page next to an issuer label
   * ("ח.פ", "עוסק מורשה"); reference - the supplier table / the registrar lookup by the supplier's
   * name (not labelled on the page). null when nothing replaced it.
   */
  replacementSource: 'issuer_label' | 'reference' | null;
}

/** Rule violation (blocks approval flows) when a buyer's ID was removed and nothing reliable replaced it. */
export const BUYER_VAT_UNRESOLVED_VIOLATION =
  'ח.פ. הספק לא זוהה בוודאות: המספר שחולץ שייך ללקוח ולא נמצא ח.פ. מסומן של המנפיק - נדרשת בדיקה ידנית';

/** IDs printed in the line-item descriptions: transaction / order numbers, never the issuer's ID. */
function lineItemIds(texts: readonly (string | null | undefined)[] | undefined): Set<string> {
  const ids = new Set<string>();
  for (const text of texts ?? []) {
    for (const o of findVatIdOccurrences(text)) ids.add(o.vatId);
  }
  return ids;
}

/**
 * Checks the extracted supplier VAT ID against the buyer's IDs: printed next to a buyer label, or
 * known to be the client's own ID (clientOwnIds, from its invoice history). When it is the buyer's,
 * it is replaced only by a reliable ID: the single checksum-valid ID on the page labelled as the
 * issuer's ("ח.פ", "עוסק מורשה" - not a number next to "מספר עסקה" / "אסמכתא" / "טלפון" …, and
 * not one that appears in a line-item description), else the first valid reference ID
 * (referenceIds: the supplier table, then the registrar lookup by the supplier's name). With
 * neither it is removed (the caller flags the invoice for manual review). Any other checksum-valid
 * number on the page is never taken: it is usually a transaction / order number.
 * An ID that fails the checksum and is not on the page at all (a misread) is swapped for the
 * labelled issuer ID too, but kept when there is none.
 */
export function checkSupplierVatId(params: {
  vatId: string | null | undefined;
  ocrText: string | null | undefined;
  ocrWords?: readonly OcrWord[] | null;
  clientOwnIds?: readonly string[];
  /** Line-item descriptions (numbers in them are never a replacement). */
  lineItemTexts?: readonly (string | null | undefined)[];
  /** Trusted IDs for this supplier, best first: supplier table, registrar lookup by name. */
  referenceIds?: readonly (string | null | undefined)[];
}): SupplierVatIdCheck {
  const id = normalizeVatId(params.vatId);
  const unchanged: SupplierVatIdCheck = { vatId: params.vatId ?? null, reason: null, replacement: null, replacementSource: null };
  if (!id) return unchanged;
  const own = new Set((params.clientOwnIds ?? []).map((v) => normalizeVatId(v)).filter((v): v is string => !!v));
  const textOccurrences = findVatIdOccurrences(params.ocrText);
  const wordOccurrences = findVatIdOccurrencesFromWords(params.ocrWords);
  const occurrences = [...textOccurrences, ...wordOccurrences];
  const itemIds = lineItemIds(params.lineItemTexts);

  const buyerIds = new Set(occurrences.filter((o) => o.buyerLabelled).map((o) => o.vatId));
  const usable = (v: string) => v !== id && !own.has(v) && !buyerIds.has(v) && !itemIds.has(v) && isValidVatIdChecksum(v);
  const issuerCandidates = [
    ...new Set(occurrences.filter((o) => o.issuerLabelled && usable(o.vatId)).map((o) => o.vatId)),
  ];
  const issuerReplacement = issuerCandidates.length === 1 ? issuerCandidates[0] : null;

  let reason: SupplierVatIdCheck['reason'] = null;
  if (own.has(id)) reason = 'client_own';
  else if (isBuyerLabelledIn(id, textOccurrences) || isBuyerLabelledIn(id, wordOccurrences)) reason = 'buyer_label';
  else if (
    !isValidVatIdChecksum(id) &&
    occurrences.length > 0 &&
    !occurrences.some((o) => o.vatId === id) &&
    issuerReplacement
  ) {
    return { vatId: issuerReplacement, reason: 'misread', replacement: issuerReplacement, replacementSource: 'issuer_label' };
  }
  if (!reason) return unchanged;

  if (issuerReplacement) {
    return { vatId: issuerReplacement, reason, replacement: issuerReplacement, replacementSource: 'issuer_label' };
  }
  const reference = (params.referenceIds ?? [])
    .map((v) => normalizeVatId(v))
    .find((v): v is string => !!v && usable(v));
  if (reference) return { vatId: reference, reason, replacement: reference, replacementSource: 'reference' };
  return { vatId: null, reason, replacement: null, replacementSource: null };
}

/** Hebrew reviewer warning for a buyer ID that was swapped / removed. */
export function supplierVatIdWarning(original: string, check: SupplierVatIdCheck): string | null {
  if (!check.reason) return null;
  if (check.reason === 'misread') {
    return `ח.פ. שזוהה (${original}) אינו תקין ואינו מופיע במסמך — הוחלף ל-${check.replacement} שמופיע בפרטי המנפיק. אנא ודא`;
  }
  const whose = check.reason === 'client_own' ? 'של הלקוח עצמו' : 'של הלקוח / הנמען בחשבונית';
  if (check.replacement && check.replacementSource === 'issuer_label') {
    return `ח.פ. שזוהה (${original}) הוא ${whose} ולא של הספק — הוחלף ל-${check.replacement} שמופיע בפרטי המנפיק. אנא ודא`;
  }
  if (check.replacement) {
    return `ח.פ. שזוהה (${original}) הוא ${whose} ולא של הספק — הוחלף ל-${check.replacement} לפי פרטי הספק המוכר / חיפוש לפי שם הספק (לא נמצא ח.פ. מסומן של המנפיק במסמך). אנא ודא מול המסמך`;
  }
  return `ח.פ. שזוהה (${original}) הוא ${whose} ולא של הספק — הוסר. לא נמצא במסמך ח.פ. מסומן של המנפיק: יש להזין את ח.פ. הספק ידנית`;
}
