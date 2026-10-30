import type { ConfidenceField, ExtractedData, FieldConfidenceMap } from '@/shared/types';

/** Fields below this model confidence are highlighted for the reviewer. */
export const LOW_CONFIDENCE_THRESHOLD = 0.7;

export const CONFIDENCE_FIELDS: readonly ConfidenceField[] = [
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

const CRITICAL_FIELDS: ConfidenceField[] = ['supplier_name', 'invoice_date', 'total_amount'];
const SECONDARY_FIELDS: ConfidenceField[] = [
  'supplier_vat_id', 'invoice_number', 'amount_before_vat', 'vat_amount', 'expense_category',
];

/** Keeps only known fields with a finite score, clamped to 0-1 (accepts 0-100 percentages too). */
export function normalizeFieldConfidence(raw: unknown): FieldConfidenceMap | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const source = raw as Record<string, unknown>;
  const result: FieldConfidenceMap = {};
  for (const field of CONFIDENCE_FIELDS) {
    const rawValue = source[field];
    const parsed = typeof rawValue === 'string' && rawValue.trim() !== '' ? Number(rawValue) : rawValue;
    if (typeof parsed !== 'number' || !Number.isFinite(parsed)) continue;
    const v = parsed > 1 && parsed <= 100 ? parsed / 100 : parsed;
    result[field] = Math.min(1, Math.max(0, Math.round(v * 100) / 100));
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/** Model confidence for a field, or null when the extraction didn't report one (old data). */
export function fieldConfidence(data: Partial<ExtractedData> | null | undefined, field: ConfidenceField): number | null {
  const v = data?.field_confidence?.[field];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function isLowConfidence(value: number | null | undefined): boolean {
  return value != null && value < LOW_CONFIDENCE_THRESHOLD;
}

/**
 * Overall invoice confidence (0.1-1).
 * Each present field counts with its model confidence (1 when none was reported, so old
 * records score exactly as before); critical fields weigh 60%, secondary 40%. Validation
 * flags then subtract a penalty.
 */
export function computeConfidence(data: Partial<ExtractedData> | null | undefined): number {
  if (!data) return 0;

  const score = (fields: ConfidenceField[]) =>
    fields.reduce((acc, f) => acc + (data[f] != null ? (fieldConfidence(data, f) ?? 1) : 0), 0) / fields.length;

  const base = score(CRITICAL_FIELDS) * 0.6 + score(SECONDARY_FIELDS) * 0.4;

  const flags = data.validation_flags;
  let penalty = 0;
  if (flags) {
    if (!flags.math_ok) penalty += 0.25;
    if (!flags.vat_id_ok) penalty += 0.10;
    if ((flags.warnings ?? []).length > 0) {
      penalty += 0.05 * Math.min((flags.warnings ?? []).length, 2);
    }
  }

  return Math.max(0.1, Math.round((base - penalty) * 100) / 100);
}
