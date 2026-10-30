import { z } from 'zod';
import type { ExtractedData, ValidationResult } from '@/shared/types';
import { isAllocationNumberWellFormed, isAllocationRequired, normalizeAllocationNumber } from '@/shared/allocation';
import { isValidVatIdChecksum, normalizeVatId } from '@/shared/vatId';
import { MAX_LINE_ITEMS } from '@/shared/lineItems';

// Server-side checks for a human approval (POST /api/invoices/[id]/approve). The review form
// mirrors the blocking rules (ValidationForm isApproveDisabled), but the server never trusts it.

/** VAT math tolerance: net + VAT may differ from the total by at most this much (ILS). */
export const APPROVAL_MATH_TOLERANCE = 1;
const MAX_AMOUNT = 1_000_000_000;

const amount = (label: string) =>
  z
    .number({ invalid_type_error: `${label} חייב להיות מספר`, required_error: `חסר ${label}` })
    .finite(`${label} אינו מספר תקין`)
    .refine((n) => Math.abs(n) < MAX_AMOUNT, `${label} גדול מדי`);

const optionalText = (label: string, max: number) =>
  z
    .string({ invalid_type_error: `${label} חייב להיות טקסט` })
    .max(max, `${label} ארוך מדי (עד ${max} תווים)`)
    .nullable()
    .optional();

const looseObject = z.record(z.unknown());

const LineItemInputSchema = z.object({
  description: z.string().max(500).nullable(),
  quantity: z.number().finite().nullable(),
  unit_price: z.number().finite().nullable(),
  line_total: z.number().finite().nullable(),
  vat_exempt: z.boolean().optional(),
});

/** Shape of the fields a reviewer may send. Unknown keys are dropped. */
export const ApprovalPayloadSchema = z.object({
  supplier_name: optionalText('שם הספק', 200),
  supplier_vat_id: optionalText('ח.פ. / עוסק מורשה', 20),
  invoice_number: optionalText('מספר החשבונית', 50),
  invoice_date: z.string({ invalid_type_error: 'תאריך החשבונית חייב להיות טקסט' }).nullable().optional(),
  amount_before_vat: amount('הסכום לפני מע"מ').nullable().optional(),
  vat_amount: amount('סכום המע"מ').nullable().optional(),
  total_amount: amount('הסכום לתשלום').nullable().optional(),
  expense_category: optionalText('סיווג ההוצאה', 100),
  allocation_number: optionalText('מספר ההקצאה', 30),
  bank_name: optionalText('שם הבנק', 100),
  bank_branch_code: optionalText('קוד הסניף', 20),
  bank_branch_name: optionalText('שם הסניף', 100),
  bank_account: optionalText('מספר החשבון', 40),
  line_items: z
    .array(LineItemInputSchema, { invalid_type_error: 'שורות החשבונית אינן תקינות' })
    .max(MAX_LINE_ITEMS, `עד ${MAX_LINE_ITEMS} שורות בחשבונית`)
    .nullable()
    .optional(),
  field_confidence: looseObject.optional(),
  validation_flags: looseObject.optional(),
  bboxes: looseObject.optional(),
  supplier_rule: looseObject.nullable().optional(),
  split_suggestion: looseObject.nullable().optional(),
});

export type ApprovalResult =
  | { ok: true; data: ExtractedData }
  | { ok: false; errors: string[] };

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a real calendar date in YYYY-MM-DD (rejects 2026-02-31, 31/02/2026, 2026-13-45). */
export function isValidIsoDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = ISO_DATE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1990 || y > 2100) return false;
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

/** An entered allocation number must be 9 digits (spaces / dashes allowed, no letters). */
export function isAllocationNumberAcceptable(value: string | null | undefined): boolean {
  return isAllocationNumberWellFormed(value) && !/[^\d\s-]/.test(value ?? '');
}

function blank(value: string | null | undefined): boolean {
  return value == null || value.trim() === '';
}

const CHECKSUM_VIOLATION = 'checksum';
const ALLOCATION_VIOLATION = 'מספר הקצאה';

/**
 * Validates an approval payload and merges it over the stored data (a partial payload must not
 * drop line items, bboxes, confidences …). Returns the final validated_data with server-computed
 * flags: vat_id_ok / math_ok / allocation_required recomputed, auto_approved cleared (a person
 * approved it), the rule violations these checks just cleared removed.
 */
export function validateApproval(payload: unknown, stored: Partial<ExtractedData> | null | undefined): ApprovalResult {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, errors: ['נתוני החשבונית לאישור חסרים או אינם תקינים'] };
  }
  const parsed = ApprovalPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return { ok: false, errors: [...new Set(parsed.error.issues.map((i) => i.message))] };
  }

  const merged = { ...(stored ?? {}), ...(parsed.data as Partial<ExtractedData>) } as Partial<ExtractedData>;
  const errors: string[] = [];

  if (!isValidIsoDate(merged.invoice_date)) {
    errors.push(blank(merged.invoice_date ?? null) ? 'חסר תאריך חשבונית' : 'תאריך החשבונית אינו תקין (נדרש YYYY-MM-DD)');
  }

  const net = merged.amount_before_vat;
  const vat = merged.vat_amount;
  const total = merged.total_amount;
  const amounts: [unknown, string][] = [[net, 'הסכום לפני מע"מ'], [vat, 'סכום המע"מ'], [total, 'הסכום לתשלום']];
  for (const [value, label] of amounts) {
    if (typeof value !== 'number' || !Number.isFinite(value)) errors.push(`חסר ${label} (מספר)`);
  }
  if (typeof net === 'number' && typeof vat === 'number' && typeof total === 'number') {
    // Credit notes are negative: all amounts must share the total's sign.
    const sign = total < 0 ? -1 : 1;
    if (net * sign < 0 || vat * sign < 0) {
      errors.push('הסכומים אינם עקביים: סכום לפני מע"מ ומע"מ חייבים להיות באותו סימן כמו הסכום לתשלום');
    }
    if (Math.abs(net + vat - total) > APPROVAL_MATH_TOLERANCE) {
      errors.push(`סכום לפני מע"מ + מע"מ אינו שווה לסכום לתשלום (הפרש מעל ₪${APPROVAL_MATH_TOLERANCE})`);
    }
  }

  if (!blank(merged.supplier_vat_id ?? null)) {
    if (!isValidVatIdChecksum(merged.supplier_vat_id)) {
      errors.push(
        normalizeVatId(merged.supplier_vat_id)
          ? 'מספר עוסק / ח.פ. אינו תקין (ספרת ביקורת שגויה)'
          : 'מספר עוסק / ח.פ. חייב להיות 9 ספרות'
      );
    }
  }

  const allocationRequired = isAllocationRequired({
    invoice_date: merged.invoice_date ?? null,
    amount_before_vat: typeof net === 'number' ? net : null,
    vat_amount: typeof vat === 'number' ? vat : null,
  });
  if (!blank(merged.allocation_number ?? null)) {
    if (!isAllocationNumberAcceptable(merged.allocation_number)) {
      errors.push('מספר ההקצאה אינו תקין - נדרשות 9 ספרות');
    }
  } else if (allocationRequired) {
    errors.push('חסר מספר הקצאה: חשבונית מעל סכום הסף לפני מע"מ - בלי מספר הקצאה לא ניתן לקזז את המע"מ');
  }

  if (errors.length > 0) return { ok: false, errors };

  const final = { ...merged } as ExtractedData;
  if (!blank(final.supplier_vat_id)) final.supplier_vat_id = normalizeVatId(final.supplier_vat_id);
  else final.supplier_vat_id = null;
  final.allocation_number = blank(final.allocation_number ?? null) ? null : normalizeAllocationNumber(final.allocation_number);

  const prevFlags = (merged.validation_flags ?? {}) as Partial<ValidationResult>;
  const violations = Array.isArray(prevFlags.rule_violations) ? prevFlags.rule_violations.filter((v) => typeof v === 'string') : [];
  final.validation_flags = {
    fields_missing: [],
    duplicate_found: false,
    warnings: [],
    requires_manual_review: true,
    ...prevFlags,
    // Every check below passed on the server just now.
    vat_id_ok: true,
    math_ok: true,
    allocation_required: allocationRequired,
    rule_violations: violations.filter((v) => !v.includes(CHECKSUM_VIOLATION) && !v.includes(ALLOCATION_VIOLATION)),
    // A person approved it: it is no longer an auto-approved invoice (eligibility / banner).
    auto_approved: false,
  } as ValidationResult;
  return { ok: true, data: final };
}
