// Deterministic sanity layer for the extracted amounts (QA: a small handwritten receipt came back as
// ₪1,000,000 at 50-60% confidence and triggered the allocation-number rule).
// Runs in validation, before the edge-case auto-corrections. Implausible amounts are removed (the
// reviewer types them in) or kept but marked unconfirmed; the model's values are kept in
// validation_flags.amount_sanity so they are not lost for learning.
import type { ExtractedData, FieldConfidenceMap } from '@/shared/types';
import { checkVatRate } from '@/shared/vatRate';
import { LOW_CONFIDENCE_THRESHOLD } from '@/shared/confidence';

export type AmountField = 'amount_before_vat' | 'vat_amount' | 'total_amount';
export const AMOUNT_FIELDS: readonly AmountField[] = ['amount_before_vat', 'vat_amount', 'total_amount'];

/** Amounts from here up must be backed by the document (OCR) or by a confident model. */
export const LARGE_AMOUNT = 10_000;
/** OCR text shorter than this (or without digits) is not used as evidence either way. */
const MIN_OCR_CHARS = 30;

export type AmountSanityReason =
  /** A round placeholder-like total (100,000 / 1,000,000 / 999,999) the document doesn't show / the model isn't sure of. */
  | 'round_placeholder'
  /** A large total whose digits (and the pre-VAT amount's) are nowhere in the OCR text. */
  | 'large_not_in_document'
  /** A large amount with low model confidence and no OCR text to back it. */
  | 'large_low_confidence'
  /** VAT doesn't match the rate for the date and at most one of the amounts is printed in the document. */
  | 'vat_mismatch_not_in_document';

export interface AmountSanityResult {
  /** 'nulled' = the amounts were removed; 'unconfirmed' = kept as a suggestion with low confidence. */
  action: 'nulled' | 'unconfirmed';
  reasons: AmountSanityReason[];
  /** The model's values, as extracted (for learning / audit). */
  original: Record<AmountField, number | null>;
}

export interface AmountSanityOutput {
  data: ExtractedData;
  result: AmountSanityResult | null;
  warning: string | null;
}

export const AMOUNT_SANITY_WARNING_PREFIX = 'הסכום שזוהה אינו סביר';

const REASON_TEXT: Record<AmountSanityReason, string> = {
  round_placeholder: 'סכום עגול חריג שלא מופיע במסמך',
  large_not_in_document: 'הסכום אינו מופיע בטקסט המסמך',
  large_low_confidence: 'סכום גבוה בוודאות נמוכה',
  vat_mismatch_not_in_document: 'המע"מ אינו תואם לשיעור המע"מ והסכומים אינם מופיעים במסמך',
};

const ils = (n: number) =>
  `₪${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function usableOcr(text: string | null | undefined): string | null {
  if (!text || text.trim().length < MIN_OCR_CHARS || !/\d/.test(text)) return null;
  return text;
}

/**
 * True when the amount is printed in the text: same digits, thousands groups optionally separated
 * by , . ' or a space, agorot as .xx / ,xx (or none / .00 for whole amounts), not part of a longer number.
 */
export function amountAppearsInText(amount: number, text: string | null | undefined): boolean {
  if (!text || !Number.isFinite(amount)) return false;
  const abs = Math.round(Math.abs(amount) * 100);
  const intPart = Math.floor(abs / 100);
  const cents = abs % 100;
  const digits = String(intPart);
  const groups: string[] = [];
  for (let end = digits.length; end > 0; end -= 3) groups.unshift(digits.slice(Math.max(0, end - 3), end));
  const intRe = groups.join("[,.'’ ]?");
  let fracRe: string;
  if (cents === 0) fracRe = '(?:[.,]00?)?';
  else {
    const c = String(cents).padStart(2, '0');
    fracRe = c.endsWith('0') ? `[.,]${c[0]}0?` : `[.,]${c}`;
  }
  const re = new RegExp(`(?<![\\d])(?<!\\d[,.'’])${intRe}${fracRe}(?![\\d])(?![.,]\\d)`);
  return re.test(text);
}

/** 100,000 / 1,000,000 / 999,999 ... : the kind of number a model fills in when it can't read one. */
export function isRoundPlaceholder(amount: number | null | undefined): boolean {
  if (amount == null || !Number.isFinite(amount)) return false;
  const abs = Math.abs(amount);
  if (abs < 100_000 || !Number.isInteger(abs)) return false;
  return /^(?:10+|9+)$/.test(String(abs)) || /^[1-9]0{5,}$/.test(String(abs));
}

const conf = (c: FieldConfidenceMap | undefined, f: AmountField) => {
  const v = c?.[f];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
};

/**
 * Checks the extracted amounts against the document. Pure: returns the (possibly) adjusted data,
 * what was found and the reviewer warning (Hebrew), or result null when the amounts look fine.
 */
export function checkAmountSanity(data: ExtractedData, ocrText?: string | null): AmountSanityOutput {
  const original: Record<AmountField, number | null> = {
    amount_before_vat: data.amount_before_vat ?? null,
    vat_amount: data.vat_amount ?? null,
    total_amount: data.total_amount ?? null,
  };
  const present = AMOUNT_FIELDS.filter((f) => original[f] != null && Number.isFinite(original[f] as number));
  if (present.length === 0) return { data, result: null, warning: null };

  const text = usableOcr(ocrText);
  const inDoc = (f: AmountField) => text != null && original[f] != null && amountAppearsInText(original[f] as number, text);
  const largest = Math.max(...present.map((f) => Math.abs(original[f] as number)));
  const lowConf = present.some((f) => {
    const c = conf(data.field_confidence, f);
    return c != null && c < LOW_CONFIDENCE_THRESHOLD;
  });
  // The headline amount: total, else the pre-VAT amount
  const headline: AmountField = original.total_amount != null ? 'total_amount' : 'amount_before_vat';

  const reasons: AmountSanityReason[] = [];
  const headlineValue = original[headline];
  if (headlineValue != null && isRoundPlaceholder(headlineValue) && (lowConf || (text != null && !inDoc(headline)))) {
    reasons.push('round_placeholder');
  }
  if (largest >= LARGE_AMOUNT) {
    if (text != null) {
      // Either the total or the pre-VAT amount printed on the page backs the invoice
      if (!inDoc('total_amount') && !inDoc('amount_before_vat')) reasons.push('large_not_in_document');
    } else if (lowConf) {
      reasons.push('large_low_confidence');
    }
  }

  let action: AmountSanityResult['action'] | null = reasons.length > 0 ? 'nulled' : null;

  // Smaller amounts: inconsistent with the VAT rate and (at most one of them) printed in the
  // document -> keep as a suggestion. A real invoice with an odd VAT prints its amounts; a model
  // reading noise (e.g. handwriting OCR'd as "773" / "145899") matches one number at best.
  if (!action && text != null && checkVatRate(data).ok === false && present.filter(inDoc).length <= 1) {
    reasons.push('vat_mismatch_not_in_document');
    action = 'unconfirmed';
  }
  if (!action) return { data, result: null, warning: null };

  const result: AmountSanityResult = { action, reasons, original };
  const suggested = [
    original.total_amount != null ? `סה"כ ${ils(original.total_amount)}` : null,
    original.amount_before_vat != null ? `לפני מע"מ ${ils(original.amount_before_vat)}` : null,
    original.vat_amount != null ? `מע"מ ${ils(original.vat_amount)}` : null,
  ].filter(Boolean).join(', ');
  const why = reasons.map((r) => REASON_TEXT[r]).join('; ');

  if (action === 'nulled') {
    const next: ExtractedData = { ...data, amount_before_vat: null, vat_amount: null, total_amount: null };
    if (data.field_confidence) {
      const c = { ...data.field_confidence };
      for (const f of AMOUNT_FIELDS) delete c[f];
      if (Object.keys(c).length > 0) next.field_confidence = c;
      else delete next.field_confidence;
    }
    return {
      data: next,
      result,
      warning: `${AMOUNT_SANITY_WARNING_PREFIX} — יש להזין ידנית (זוהה: ${suggested}; ${why})`,
    };
  }

  // Unconfirmed: values stay, highlighted as low confidence for the reviewer
  const c: FieldConfidenceMap = { ...(data.field_confidence ?? {}) };
  for (const f of present) c[f] = Math.min(conf(data.field_confidence, f) ?? 0.4, 0.4);
  return {
    data: { ...data, field_confidence: c },
    result,
    warning: `${AMOUNT_SANITY_WARNING_PREFIX} — הסכומים לא נמצאו במסמך, יש לבדוק ולהזין ידנית (${suggested}; ${why})`,
  };
}
