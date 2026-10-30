import type {
  DuplicateMatch,
  DuplicateReason,
  ExtractedData,
  InvoiceStatus,
  ValidationResult,
} from '@/shared/types';
import { isValidVatIdChecksum } from '@/shared/vatId';

// Duplicate / fraud detection rules (pure logic, no DB access).
// Three signals, strongest first:
//   same_file   - identical file bytes (SHA-256) for the same client
//   same_number - same supplier + same normalized invoice number
//   fuzzy       - same supplier, total within FUZZY_AMOUNT_TOLERANCE, date within FUZZY_DATE_WINDOW_DAYS
// Rejected invoices never count, and a pair the reviewer dismissed is never flagged again.

export const FUZZY_AMOUNT_TOLERANCE = 1; // ILS
export const FUZZY_DATE_WINDOW_DAYS = 3;
export const MAX_DUPLICATE_MATCHES = 10;

// Every duplicate rule violation starts with this, so it can be replaced / cleared later.
export const DUPLICATE_VIOLATION_PREFIX = 'חשבונית כפולה';

// Placeholder supplier names the review form uses for unmapped suppliers - not a real identity.
const GENERIC_SUPPLIER_NAMES = ['ספקים שונים'];

const REASON_RANK: Record<DuplicateReason, number> = { same_file: 0, same_number: 1, fuzzy: 2 };

/** The subset of an invoices row the matcher needs. */
export interface DuplicateCandidateRow {
  id: string;
  status?: InvoiceStatus | null;
  file_name?: string | null;
  file_hash?: string | null;
  created_at?: string | null;
  extracted_data?: Partial<ExtractedData> | null;
  validated_data?: Partial<ExtractedData> | null;
}

/** The invoice being validated: its current (corrected) data plus its file fingerprint. */
export interface DuplicateTarget {
  id: string;
  file_hash: string | null;
  data: Partial<ExtractedData>;
}

interface Fingerprint {
  fileHash: string | null;
  vatId: string | null;
  names: string[];
  invoiceNumber: string | null;
  invoiceDate: string | null;
  total: number | null;
}

// ─── Normalizers ───────────────────────────────────────────────────────────────

/** Keep in sync with public.normalize_invoice_number() in supabase/migrations. */
export function normalizeInvoiceNumber(value: string | null | undefined): string | null {
  if (value == null) return null;
  const clean = String(value).replace(/[^0-9A-Za-z]/g, '').toUpperCase().replace(/^0+/, '');
  return clean || null;
}

/** Digits only, 8-digit IDs padded to 9 (same rule as the validation VAT ID check). */
export function normalizeVatId(value: string | null | undefined): string | null {
  if (value == null) return null;
  const digits = String(value).replace(/\D/g, '');
  if (!digits || /^0+$/.test(digits)) return null;
  return digits.length === 8 ? `0${digits}` : digits;
}

const HEBREW_FINAL_LETTERS: Record<string, string> = { 'ך': 'כ', 'ם': 'מ', 'ן': 'נ', 'ף': 'פ', 'ץ': 'צ' };

// Case, Hebrew final letters and punctuation folded away; words separated by single spaces.
function foldName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[ךםןףץ]/g, (c) => HEBREW_FINAL_LETTERS[c])
    .replace(/[^0-9a-zא-ת]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

const GENERIC_SUPPLIER_KEYS = new Set(GENERIC_SUPPLIER_NAMES.map(foldName));

/** Loose supplier-name key: case, punctuation, Hebrew final letters and legal suffixes ignored. */
export function normalizeSupplierName(value: string | null | undefined): string | null {
  if (value == null) return null;
  // Legal-entity suffixes (בע"מ / בע״מ / בעמ / Ltd / Inc) say nothing about which supplier it is
  const withoutSuffix = String(value)
    .toLowerCase()
    .replace(/(?<![\u0590-\u05FF])בע["'״׳]?\s*מ(?![\u0590-\u05FF])/g, ' ')
    .replace(/\b(ltd|limited|inc|co)\b\.?/g, ' ');
  const key = foldName(withoutSuffix);
  if (!key || GENERIC_SUPPLIER_KEYS.has(key)) return null;
  return key;
}

function parseIsoDate(value: string | null | undefined): number | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(t);
  // Reject roll-overs like 2026-02-30
  if (d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) return null;
  return t;
}

/** Whole days between two YYYY-MM-DD dates, or null when either is missing/invalid. */
export function daysBetween(a: string | null | undefined, b: string | null | undefined): number | null {
  const ta = parseIsoDate(a);
  const tb = parseIsoDate(b);
  if (ta == null || tb == null) return null;
  return Math.round(Math.abs(ta - tb) / 86_400_000);
}

/** The [from, to] YYYY-MM-DD window used to pre-filter fuzzy candidates in the DB. */
export function fuzzyDateWindow(date: string | null | undefined): { from: string; to: string } | null {
  const t = parseIsoDate(date);
  if (t == null) return null;
  const shift = (days: number) => new Date(t + days * 86_400_000).toISOString().slice(0, 10);
  return { from: shift(-FUZZY_DATE_WINDOW_DAYS), to: shift(FUZZY_DATE_WINDOW_DAYS) };
}

function toAmount(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

// ─── Matching ──────────────────────────────────────────────────────────────────

/** Reviewer-approved values win over the raw AI extraction, field by field. */
function effective<K extends keyof ExtractedData>(row: DuplicateCandidateRow, key: K): ExtractedData[K] | null {
  return (row.validated_data?.[key] ?? row.extracted_data?.[key] ?? null) as ExtractedData[K] | null;
}

function fingerprintOfData(data: Partial<ExtractedData>, fileHash: string | null): Fingerprint {
  const name = normalizeSupplierName(data.supplier_name);
  return {
    fileHash: fileHash || null,
    vatId: normalizeVatId(data.supplier_vat_id),
    names: name ? [name] : [],
    invoiceNumber: normalizeInvoiceNumber(data.invoice_number),
    invoiceDate: data.invoice_date ?? null,
    total: toAmount(data.total_amount),
  };
}

function fingerprintOfRow(row: DuplicateCandidateRow): Fingerprint {
  // Both names count: the reviewer may have renamed the supplier to its mapped key
  const names = [row.validated_data?.supplier_name, row.extracted_data?.supplier_name]
    .map(normalizeSupplierName)
    .filter((n): n is string => !!n);
  return {
    fileHash: row.file_hash || null,
    vatId: normalizeVatId(effective(row, 'supplier_vat_id')),
    names: Array.from(new Set(names)),
    invoiceNumber: normalizeInvoiceNumber(effective(row, 'invoice_number')),
    invoiceDate: effective(row, 'invoice_date'),
    total: toAmount(effective(row, 'total_amount')),
  };
}

/**
 * Same supplier: equal VAT IDs when both have one (two different valid IDs = different suppliers,
 * whatever the names say); otherwise any equal normalized name. An ID that fails the checksum is a
 * misread, so it doesn't prove a different supplier: the names decide (the same page read twice must
 * still be caught as a duplicate when one read garbled the VAT ID).
 */
function sameSupplier(a: Fingerprint, b: Fingerprint): boolean {
  if (a.vatId && b.vatId) {
    if (a.vatId === b.vatId) return true;
    if (isValidVatIdChecksum(a.vatId) && isValidVatIdChecksum(b.vatId)) return false;
  }
  return a.names.some((n) => b.names.includes(n));
}

/** The strongest reason `candidate` looks like a duplicate of `target`, or null. */
export function duplicateReason(target: Fingerprint, candidate: Fingerprint): DuplicateReason | null {
  if (target.fileHash && candidate.fileHash && target.fileHash === candidate.fileHash) return 'same_file';
  if (!sameSupplier(target, candidate)) return null;
  if (target.invoiceNumber && candidate.invoiceNumber && target.invoiceNumber === candidate.invoiceNumber) {
    return 'same_number';
  }
  if (target.total == null || candidate.total == null) return null;
  // Compared in agorot so float noise (2.14 - 1.14 = 1.0000000000000002) doesn't break the 1 ILS edge
  if (Math.round(Math.abs(target.total - candidate.total) * 100) > FUZZY_AMOUNT_TOLERANCE * 100) return null;
  const days = daysBetween(target.invoiceDate, candidate.invoiceDate);
  if (days == null || days > FUZZY_DATE_WINDOW_DAYS) return null;
  return 'fuzzy';
}

/**
 * Returns the invoices `target` is suspected to duplicate, strongest reason first, newest first
 * within a reason. Skips itself, rejected invoices and dismissed pairs.
 */
export function findDuplicateMatches(
  target: DuplicateTarget,
  candidates: DuplicateCandidateRow[],
  dismissedOtherIds: Iterable<string> = []
): DuplicateMatch[] {
  const dismissed = new Set(dismissedOtherIds);
  const self = fingerprintOfData(target.data, target.file_hash);
  const seen = new Set<string>();
  const matches: (DuplicateMatch & { created_at: string })[] = [];

  for (const row of candidates) {
    if (!row?.id || row.id === target.id || seen.has(row.id)) continue;
    seen.add(row.id);
    if (row.status === 'rejected' || dismissed.has(row.id)) continue;

    const reason = duplicateReason(self, fingerprintOfRow(row));
    if (!reason) continue;
    matches.push({
      invoice_id: row.id,
      reason,
      file_name: row.file_name ?? null,
      invoice_number: effective(row, 'invoice_number'),
      invoice_date: effective(row, 'invoice_date'),
      total_amount: toAmount(effective(row, 'total_amount')),
      status: row.status ?? null,
      created_at: row.created_at ?? '',
    });
  }

  return matches
    .sort((a, b) => REASON_RANK[a.reason] - REASON_RANK[b.reason] || b.created_at.localeCompare(a.created_at))
    .slice(0, MAX_DUPLICATE_MATCHES)
    .map(({ created_at: _createdAt, ...m }) => m);
}

// ─── Messages & flags ──────────────────────────────────────────────────────────

export const DUPLICATE_REASON_LABELS: Record<DuplicateReason, string> = {
  same_file: 'אותו קובץ בדיוק',
  same_number: 'אותו ספק ומספר חשבונית',
  fuzzy: 'אותו ספק, סכום ותאריך קרובים',
};

/** One rule violation per reason present (all start with DUPLICATE_VIOLATION_PREFIX). */
export function duplicateViolationMessages(matches: DuplicateMatch[], invoiceNumber?: string | null): string[] {
  const reasons = new Set(matches.map((m) => m.reason));
  const messages: string[] = [];
  if (reasons.has('same_file')) {
    messages.push(`${DUPLICATE_VIOLATION_PREFIX}: הקובץ הזה כבר הועלה בעבר עבור לקוח זה`);
  }
  if (reasons.has('same_number')) {
    messages.push(
      invoiceNumber
        ? `${DUPLICATE_VIOLATION_PREFIX}: מספר חשבונית ${invoiceNumber} עבור ספק זה כבר קיים במערכת`
        : `${DUPLICATE_VIOLATION_PREFIX}: מספר החשבונית עבור ספק זה כבר קיים במערכת`
    );
  }
  if (reasons.has('fuzzy')) {
    messages.push(
      `${DUPLICATE_VIOLATION_PREFIX} (חשד): קיימת חשבונית מאותו ספק בסכום זהה (±₪${FUZZY_AMOUNT_TOLERANCE}) ובתאריך קרוב (±${FUZZY_DATE_WINDOW_DAYS} ימים)`
    );
  }
  return messages;
}

/** Replaces the duplicate part of the validation flags with `matches`, leaving everything else as is. */
export function applyDuplicateMatches(
  flags: ValidationResult,
  matches: DuplicateMatch[],
  invoiceNumber?: string | null
): ValidationResult {
  const otherViolations = (flags.rule_violations ?? []).filter((v) => !v.startsWith(DUPLICATE_VIOLATION_PREFIX));
  return {
    ...flags,
    duplicate_found: matches.length > 0,
    duplicate_matches: matches,
    rule_violations: [...otherViolations, ...duplicateViolationMessages(matches, invoiceNumber)],
  };
}

/** Flags with one dismissed invoice removed from the duplicate matches (no-op when it isn't there). */
export function dismissDuplicateInFlags(
  flags: ValidationResult,
  otherInvoiceId: string,
  invoiceNumber?: string | null
): ValidationResult {
  const remaining = (flags.duplicate_matches ?? []).filter((m) => m.invoice_id !== otherInvoiceId);
  return applyDuplicateMatches(flags, remaining, invoiceNumber);
}
