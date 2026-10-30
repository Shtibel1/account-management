// Display helpers for the review screen's document pane.
import type { BboxMap } from '@/shared/types';

/** Hebrew labels of the invoice fields (same wording as the review form). */
export const FIELD_LABELS: Record<string, string> = {
  supplier_name: 'שם ספק',
  supplier_vat_id: 'ח.פ. / עוסק מורשה',
  invoice_number: 'מספר חשבונית',
  invoice_date: 'תאריך חשבונית',
  amount_before_vat: 'לפני מע״מ',
  vat_amount: 'מע״מ',
  total_amount: 'סה״כ לתשלום',
  expense_category: 'קטגוריית הוצאה',
  allocation_number: 'מספר הקצאה',
  bank_name: 'שם הבנק',
  bank_branch_name: 'שם הסניף',
  bank_branch_code: 'מספר סניף',
  bank_account: 'מספר חשבון',
};

/** Hebrew label for a field key; unknown keys get a generic label instead of the raw English key. */
export function fieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? 'שדה';
}

/** Fields whose box from the model is a guess and is shown only once snapped to the OCR words. */
const OCR_ONLY_FIELDS: (keyof BboxMap)[] = ['allocation_number'];

/**
 * Boxes to draw. OCR-snapped boxes carry a page number; when the document has those, a box of an
 * OCR-only field without one is the model's unsnapped guess (often an empty region) and is hidden.
 */
export function displayBboxes(bboxes: BboxMap | null | undefined): BboxMap | undefined {
  if (!bboxes) return undefined;
  const snapped = Object.values(bboxes).some((b) => b != null && b.page != null);
  if (!snapped) return bboxes;
  const result: BboxMap = { ...bboxes };
  for (const field of OCR_ONLY_FIELDS) {
    if (result[field] && result[field]?.page == null) delete result[field];
  }
  return result;
}
