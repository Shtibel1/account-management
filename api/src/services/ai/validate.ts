import type { ExtractedData, ValidationFlags } from '@invoice/shared-types';
import { runEdgeCaseHandlers } from './edge-cases.js';

const REQUIRED_FIELDS: (keyof ExtractedData)[] = [
  'supplier_name', 'supplier_vat_id', 'invoice_date',
  'amount_before_vat', 'vat_amount', 'total_amount',
];

export function validateInvoiceData(data: ExtractedData): ExtractedData {
  // הרץ edge case handlers תחילה (כולל auto-correction)
  const { data: corrected, warnings } = runEdgeCaseHandlers(data);

  const flags: ValidationFlags = {
    math_ok: checkMath(corrected),
    vat_id_ok: checkVatId(corrected.supplier_vat_id),
    fields_missing: REQUIRED_FIELDS.filter((f) => corrected[f] == null) as string[],
  };

  // שמור warnings כחלק מ-validation_flags להצגה בממשק
  return {
    ...corrected,
    validation_flags: {
      ...flags,
      warnings: warnings as any,
    } as ValidationFlags,
  };
}

function checkMath(data: ExtractedData): boolean {
  const { amount_before_vat: before, vat_amount: vat, total_amount: total } = data;
  if (before == null || vat == null || total == null) return true;
  return Math.abs((before + vat) - total) <= 1;
}

function checkVatId(vatId: string | null): boolean {
  if (!vatId) return true;
  const digits = vatId.replace(/\D/g, '');
  if (digits.length !== 9) return false;

  // אלגוריתם Luhn ישראלי
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    let d = parseInt(digits[i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}
