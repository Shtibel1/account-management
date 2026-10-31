// Deterministic sanity check for the extracted invoice date (QA: a handwritten "3/6/26" on a receipt
// book with "2015" printed on it came back as 2015-08-26 at 85-90% confidence).
// Runs in validation next to the amount sanity layer. An implausible date is kept (the reviewer may
// really be entering an old invoice), but its confidence is lowered so it is highlighted and blocks
// auto-approve, and the reviewer gets a warning. The review form drops the warning live once the
// date is changed to a plausible one (src/shared/reviewWarnings.ts).

/** Invoice dates more than this many days after the upload date are suspicious. */
export const DATE_FUTURE_TOLERANCE_DAYS = 3;
/** Invoice dates more than this many months before the upload date are suspicious. */
export const DATE_MAX_AGE_MONTHS = 18;
/** Confidence an implausible date is capped at (below LOW_CONFIDENCE_THRESHOLD). */
export const IMPLAUSIBLE_DATE_CONFIDENCE = 0.4;

export const DATE_SANITY_WARNING = 'תאריך החשבונית רחוק מתאריך ההעלאה — יש לוודא';

export type DateSanityReason = 'future' | 'too_old';

export interface DateSanityResult {
  reason: DateSanityReason;
  /** The extracted date (YYYY-MM-DD), kept on the invoice. */
  original: string;
  /** The date it was compared with (the upload date, YYYY-MM-DD). */
  reference_date: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function parseIsoDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  // Rejects 2026-02-31 and the like
  if (d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) return null;
  return d;
}

/** YYYY-MM-DD of a Date or ISO timestamp, in Israel time (an upload at 01:00 IL is still that day). */
export function referenceDay(reference: Date | string | null | undefined): string {
  const d = reference == null ? new Date() : typeof reference === 'string' ? new Date(reference) : reference;
  const valid = Number.isFinite(d.getTime()) ? d : new Date();
  return valid.toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
}

/**
 * Why the invoice date is implausible relative to the upload date, or null when it looks fine
 * (or there is no parseable date). `reference` defaults to now.
 */
export function checkInvoiceDateSanity(
  invoiceDate: string | null | undefined,
  reference?: Date | string | null
): DateSanityResult | null {
  const date = parseIsoDate(invoiceDate);
  if (!date) return null;
  const refDay = referenceDay(reference);
  const ref = parseIsoDate(refDay) as Date;
  const original = date.toISOString().slice(0, 10);

  if (date.getTime() - ref.getTime() > DATE_FUTURE_TOLERANCE_DAYS * DAY_MS) {
    return { reason: 'future', original, reference_date: refDay };
  }
  // Same day N months back, clamped to the month's last day (Oct 31 - 18 months = Apr 30)
  const monthIndex = ref.getUTCFullYear() * 12 + ref.getUTCMonth() - DATE_MAX_AGE_MONTHS;
  const year = Math.floor(monthIndex / 12);
  const month = monthIndex - year * 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const oldest = new Date(Date.UTC(year, month, Math.min(ref.getUTCDate(), lastDay)));
  if (date.getTime() < oldest.getTime()) {
    return { reason: 'too_old', original, reference_date: refDay };
  }
  return null;
}

/** True when the invoice date is implausible relative to the upload date. */
export function isImplausibleInvoiceDate(invoiceDate: string | null | undefined, reference?: Date | string | null): boolean {
  return checkInvoiceDateSanity(invoiceDate, reference) != null;
}
