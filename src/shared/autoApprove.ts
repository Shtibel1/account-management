// Per-supplier auto-approve (Dext-style "supplier you trust").
//
// Eligibility (a suggestion only): the supplier's last AUTO_APPROVE_HISTORY_SIZE human-reviewed
// invoices (invoices.reviewed_at set) had zero rows in invoice_corrections.
// Auto-approve happens only when the client opted the supplier in (supplier_automation.auto_approve)
// AND every validation check passed. Auto-approved invoices never get reviewed_at, so they don't
// count toward accuracy / eligibility. A later human review with corrections turns the opt-in off.
import type { SupplierEligibility, ValidationResult } from '@/shared/types';

/** How many recent human-reviewed invoices must be correction-free for a supplier to be eligible. */
export const AUTO_APPROVE_HISTORY_SIZE = 5;

export interface ReviewedInvoiceRef {
  invoice_id: string;
  supplier_vat_id: string | null; // normalized
  reviewed_at: string;
}

/** Eligibility per supplier VAT ID from the client's human-reviewed invoices and the set of invoices that had corrections. */
export function computeSupplierEligibility(
  reviewed: readonly ReviewedInvoiceRef[],
  correctedInvoiceIds: ReadonlySet<string>,
  historySize: number = AUTO_APPROVE_HISTORY_SIZE
): Map<string, SupplierEligibility> {
  const bySupplier = new Map<string, ReviewedInvoiceRef[]>();
  for (const inv of reviewed) {
    if (!inv.supplier_vat_id || !inv.reviewed_at) continue;
    const list = bySupplier.get(inv.supplier_vat_id) ?? [];
    list.push(inv);
    bySupplier.set(inv.supplier_vat_id, list);
  }

  const result = new Map<string, SupplierEligibility>();
  for (const [vatId, list] of bySupplier) {
    const newestFirst = [...list].sort((a, b) => (a.reviewed_at < b.reviewed_at ? 1 : a.reviewed_at > b.reviewed_at ? -1 : 0));
    let cleanStreak = 0;
    while (cleanStreak < newestFirst.length && !correctedInvoiceIds.has(newestFirst[cleanStreak].invoice_id)) {
      cleanStreak++;
    }
    result.set(vatId, {
      supplier_vat_id: vatId,
      reviewed_count: newestFirst.length,
      clean_streak: cleanStreak,
      eligible: cleanStreak >= historySize,
    });
  }
  return result;
}

export interface AutoApproveCheck {
  supplierVatId: string | null;
  result: Pick<
    ValidationResult,
    'math_ok' | 'vat_id_ok' | 'fields_missing' | 'rule_violations' | 'duplicate_found' | 'not_an_invoice'
  >;
  /** False when the duplicate check was skipped or its query failed: we can't rule out a duplicate. */
  duplicateCheckRan: boolean;
  /** True when the edge-case handlers had to rewrite the amounts (before VAT + VAT ≠ total). */
  amountsAutoCorrected: boolean;
}

/** Reasons an opted-in supplier's invoice still needs manual review (empty = may auto-approve). */
export function autoApproveBlockers(check: AutoApproveCheck): string[] {
  const { result } = check;
  const blockers: string[] = [];
  if (result.not_an_invoice) blockers.push('המסמך לא זוהה כחשבונית');
  if (!check.supplierVatId) blockers.push('חסר ח.פ. ספק');
  if (!result.math_ok) blockers.push('הסכומים לא מסתדרים');
  if (check.amountsAutoCorrected) blockers.push('הסכומים תוקנו אוטומטית');
  if (!result.vat_id_ok) blockers.push('ח.פ. אינו תקין');
  if (result.fields_missing.length > 0) blockers.push(`חסרים שדות: ${result.fields_missing.join(', ')}`);
  if (result.rule_violations.length > 0) blockers.push(...result.rule_violations);
  if (result.duplicate_found) blockers.push('נמצאה חשבונית כפולה');
  else if (!check.duplicateCheckRan) blockers.push('בדיקת כפילות לא הושלמה');
  return blockers;
}

/** True only when the supplier is opted in and nothing blocks auto-approval. */
export function shouldAutoApprove(optedIn: boolean, check: AutoApproveCheck): boolean {
  return optedIn && autoApproveBlockers(check).length === 0;
}
