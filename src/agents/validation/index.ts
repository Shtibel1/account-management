import type { ExtractedData, TenantRules, ValidationResult } from '@/shared/types';
import { supabase } from '@/lib/supabase';

const REQUIRED_FIELDS: (keyof ExtractedData)[] = [
  'supplier_name',
  'supplier_vat_id',
  'invoice_date',
  'amount_before_vat',
  'vat_amount',
  'total_amount',
];

interface EdgeCaseResult {
  data: ExtractedData;
  warnings: string[];
  corrected: boolean;
}

// ─── Edge Case Handlers (Copied and adapted from legacy) ───────────────────────

function runEdgeCaseHandlers(data: ExtractedData): EdgeCaseResult {
  let current = { ...data };
  const warnings: string[] = [];
  let corrected = false;

  // 1. VAT Auto Correct: before_vat + vat !== total
  const { amount_before_vat: b, vat_amount: v, total_amount: t } = current;
  if (b != null && v != null && t != null && Math.abs((b + v) - t) > 1) {
    const correctedAmount = Math.round((t - v) * 100) / 100;
    current.amount_before_vat = correctedAmount;
    warnings.push(`סכום לפני מע"מ תוקן אוטומטית ל-₪${correctedAmount} (= סה"כ - מע"מ)`);
    corrected = true;
  }

  // 2. Exempt Supplier (No VAT)
  if ((current.vat_amount === 0 || current.vat_amount == null) && current.total_amount != null && current.total_amount > 0) {
    current.vat_amount = 0;
    current.amount_before_vat = current.total_amount;
    warnings.push('נראה שמדובר בעוסק פטור ממע"מ — אנא ודא');
    corrected = true;
  }

  // 3. Credit Note (Negative Amount)
  if (current.total_amount != null && current.total_amount < 0) {
    warnings.push('זוהתה חשבונית זיכוי (סכום שלילי) — בדוק שהקטגוריה נכונה');
  }

  // 4. Missing Date
  if (current.invoice_date == null) {
    warnings.push('לא נמצא תאריך בחשבונית — ייתכן שמדובר בקבלה בלבד');
  }

  return { data: current, warnings, corrected };
}

// ─── Validation Helpers ────────────────────────────────────────────────────────

function checkMath(data: ExtractedData): boolean {
  const { amount_before_vat: before, vat_amount: vat, total_amount: total } = data;
  if (before == null || vat == null || total == null) return true;
  return Math.abs((before + vat) - total) <= 1; // 1.00 ILS tolerance
}

function checkVatId(vatId: string | null): boolean {
  if (!vatId) return true;
  const digits = vatId.replace(/\D/g, '');
  if (digits.length !== 9) return false;

  // Israeli Luhn checksum algorithm
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    let d = parseInt(digits[i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

// ─── Core Validation Entry Point ───────────────────────────────────────────────

export async function validateInvoice(
  invoiceId: string,
  tenantId: string,
  data: ExtractedData,
  rules: TenantRules
): Promise<{ data: ExtractedData; validationResult: ValidationResult }> {
  // 1. Run edge cases & auto-corrections
  const { data: corrected, warnings } = runEdgeCaseHandlers(data);

  // 2. Perform baseline structural checks
  const mathOk = checkMath(corrected);
  const vatIdOk = checkVatId(corrected.supplier_vat_id);

  // Determine missing fields based on tenant rules & system defaults
  const missingFields: string[] = [];
  if (!corrected.supplier_name) missingFields.push('supplier_name');
  if (rules.requireVatId && !corrected.supplier_vat_id) missingFields.push('supplier_vat_id');
  if (rules.requireInvoiceDate && !corrected.invoice_date) missingFields.push('invoice_date');
  if (rules.requireExpenseCategory && !corrected.expense_category) missingFields.push('expense_category');
  
  // Base fields that must always be present
  if (corrected.amount_before_vat == null) missingFields.push('amount_before_vat');
  if (corrected.vat_amount == null) missingFields.push('vat_amount');
  if (corrected.total_amount == null) missingFields.push('total_amount');

  // 3. Rule evaluations
  const ruleViolations: string[] = [];

  // Exceeds maximum budget rule
  if (corrected.total_amount != null && corrected.total_amount > rules.maxAmountForAutoApprove) {
    ruleViolations.push(
      `סכום החשבונית (₪${corrected.total_amount}) עולה על סף האישור האוטומטי (₪${rules.maxAmountForAutoApprove})`
    );
  }

  // Category whitelist check
  if (
    corrected.expense_category &&
    rules.allowedExpenseCategories.length > 0 &&
    !rules.allowedExpenseCategories.includes(corrected.expense_category)
  ) {
    ruleViolations.push(`קטגוריית ההוצאה "${corrected.expense_category}" אינה מורשית עבור לקוח זה`);
  }

  // VAT ID requirement fallback
  if (rules.requireVatId && !vatIdOk) {
    ruleViolations.push('ח.פ. / עוסק מורשה אינו תקין לפי בדיקת checksum');
  }

  // 4. Duplicate checks
  let duplicateFound = false;
  if (rules.duplicateInvoiceCheck && corrected.supplier_vat_id && corrected.invoice_number) {
    try {
      const { data: existing, error } = await supabase
        .from('invoices')
        .select('id')
        .eq('client_id', tenantId)
        // PostgreSQL JSONB querying syntax to check extracted_data or validated_data
        .or(`extracted_data->>supplier_vat_id.eq.${corrected.supplier_vat_id},validated_data->>supplier_vat_id.eq.${corrected.supplier_vat_id}`)
        .or(`extracted_data->>invoice_number.eq.${corrected.invoice_number},validated_data->>invoice_number.eq.${corrected.invoice_number}`)
        .not('id', 'eq', invoiceId);

      if (error) {
        console.error('Error running duplicate check query:', error);
      } else if (existing && existing.length > 0) {
        duplicateFound = true;
        ruleViolations.push(`חשבונית כפולה: מספר חשבונית ${corrected.invoice_number} עבור ספק זה כבר קיים במערכת`);
      }
    } catch (err) {
      console.error('Failed to run duplicate invoice database check:', err);
    }
  }

  // 5. Compute manual review trigger
  const requiresManualReview =
    !mathOk ||
    !vatIdOk ||
    missingFields.length > 0 ||
    duplicateFound ||
    ruleViolations.length > 0;

  const validationResult: ValidationResult = {
    math_ok: mathOk,
    vat_id_ok: vatIdOk,
    fields_missing: missingFields,
    duplicate_found: duplicateFound,
    rule_violations: ruleViolations,
    warnings,
    requires_manual_review: requiresManualReview,
  };

  return {
    data: {
      ...corrected,
      validation_flags: validationResult,
    },
    validationResult,
  };
}
