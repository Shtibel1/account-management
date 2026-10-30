// The supplier's VAT ID is the issuer's (seller's) ח.פ. / עוסק מורשה. Invoices also print the
// buyer's ID in the customer block ("לכבוד", "ח.פ לקוח"), and the model sometimes takes that one.
// These helpers find each ID's label context in the OCR text so validation can swap or flag it.
import { isValidVatIdChecksum, normalizeVatId } from '@/shared/vatId';

/** Labels of the buyer / customer block. "לקוחות" (as in "שירות לקוחות") is not a buyer label. */
const BUYER_LABEL = /לכבוד|לקוח(?!ות)|נמען|מזמין|(?<![֐-׿])קונה(?![֐-׿])/;

/** Characters on each side of the number that count as "next to" a label (same line only). */
const CONTEXT_CHARS = 28;

/** Digit groups joined by single hyphens / spaces inside a number (e.g. 51-180380-5), not glued to other digits. */
const NUMBER_PATTERN = /(?<![\d-])\d+(?:[- ]\d+)*(?![\d-])/g;

export interface VatIdOccurrence {
  vatId: string;
  /** True when a buyer label sits next to the number on the same line. */
  buyerLabelled: boolean;
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
        result.push({ vatId, buyerLabelled: BUYER_LABEL.test(before) || BUYER_LABEL.test(after) });
      }
    }
  }
  return result;
}

/** True when the ID appears in the OCR text only next to buyer labels (never in the issuer's header / footer). */
export function isBuyerLabelledVatId(vatId: string | null | undefined, ocrText: string | null | undefined): boolean {
  const id = normalizeVatId(vatId);
  if (!id) return false;
  const hits = findVatIdOccurrences(ocrText).filter((o) => o.vatId === id);
  return hits.length > 0 && hits.every((o) => o.buyerLabelled);
}

export interface SupplierVatIdCheck {
  /** The VAT ID to keep: the original, the issuer's ID it was swapped for, or null when removed. */
  vatId: string | null;
  /** Why the extracted ID is not the supplier's (null = it looks fine). */
  reason: 'buyer_label' | 'client_own' | null;
  /** The issuer ID used instead, when one was found. */
  replacement: string | null;
}

/**
 * Checks the extracted supplier VAT ID against the buyer's IDs: printed next to a buyer label, or
 * known to be the client's own ID (clientOwnIds, from its invoice history). When it is the buyer's,
 * the only other checksum-valid, non-buyer ID on the page replaces it; with no single candidate it is removed.
 */
export function checkSupplierVatId(params: {
  vatId: string | null | undefined;
  ocrText: string | null | undefined;
  clientOwnIds?: readonly string[];
}): SupplierVatIdCheck {
  const id = normalizeVatId(params.vatId);
  const own = new Set((params.clientOwnIds ?? []).map((v) => normalizeVatId(v)).filter((v): v is string => !!v));
  if (!id) return { vatId: params.vatId ?? null, reason: null, replacement: null };

  const reason: SupplierVatIdCheck['reason'] = own.has(id)
    ? 'client_own'
    : isBuyerLabelledVatId(id, params.ocrText)
      ? 'buyer_label'
      : null;
  if (!reason) return { vatId: params.vatId ?? null, reason: null, replacement: null };

  const occurrences = findVatIdOccurrences(params.ocrText);
  const buyerIds = new Set(occurrences.filter((o) => o.buyerLabelled).map((o) => o.vatId));
  const candidates = [
    ...new Set(
      occurrences
        .map((o) => o.vatId)
        .filter((v) => v !== id && !own.has(v) && !buyerIds.has(v) && isValidVatIdChecksum(v))
    ),
  ];
  const replacement = candidates.length === 1 ? candidates[0] : null;
  return { vatId: replacement, reason, replacement };
}

/** Hebrew reviewer warning for a buyer ID that was swapped / removed. */
export function supplierVatIdWarning(original: string, check: SupplierVatIdCheck): string | null {
  if (!check.reason) return null;
  const whose = check.reason === 'client_own' ? 'של הלקוח עצמו' : 'של הלקוח / הנמען בחשבונית';
  return check.replacement
    ? `ח.פ. שזוהה (${original}) הוא ${whose} ולא של הספק — הוחלף ל-${check.replacement} שמופיע בפרטי המנפיק. אנא ודא`
    : `ח.פ. שזוהה (${original}) הוא ${whose} ולא של הספק — הוסר. יש להזין את ח.פ. הספק מתוך פרטי המנפיק`;
}
