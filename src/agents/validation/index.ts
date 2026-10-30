import type { DuplicateMatch, ExtractedData, OcrWord, SupplierRuleTrace, TenantRules, ValidationResult } from '@/shared/types';
import { supabase } from '@/lib/supabase';
import { fetchSupplierMappings, isAutoApproveEnabled } from '@/lib/supplierAutomation';
import { applySupplierRule, findSupplierRule, isGenericSupplierName, normalizeVatId } from '@/shared/supplierRules';
import { amountsChanged, autoApproveBlockers } from '@/shared/autoApprove';
import { findDuplicatesForInvoice } from '@/lib/duplicates';
import { duplicateViolationMessages } from '@/shared/duplicates';
import { searchVatIdByName } from '@/utils/businessLookup';
import {
  allocationThreshold,
  isAllocationNumberWellFormed,
  isAllocationRequired,
  normalizeAllocationNumber,
} from '@/shared/allocation';
import { isValidVatIdChecksum } from '@/shared/vatId';
import { checkLineItemsSum, hasMixedVat, lineItemWarnings, normalizeLineItems } from '@/shared/lineItems';
import { CONFIDENCE_FIELDS, fieldConfidence, isLowConfidence, pruneFieldConfidence } from '@/shared/confidence';
import { vatRateWarning } from '@/shared/vatRate';
import { checkSupplierVatId, supplierVatIdWarning } from '@/shared/buyerVatId';
import { isZeroVatInvoice, ZERO_VAT_WITH_HISTORY_WARNING } from '@/shared/supplierVatHistory';
import { fetchClientOwnVatIds, fetchSupplierVatHistory } from '@/lib/validationHistory';

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
  // Israeli Luhn checksum algorithm (shared with the few-shot supplier lookup)
  return isValidVatIdChecksum(vatId);
}

// ─── Core Validation Entry Point ───────────────────────────────────────────────

export interface ValidationContext {
  /** Full OCR text of the document: used to tell the issuer's VAT ID from the buyer's. */
  ocrText?: string | null;
  /** OCR word boxes: tell label/value columns of a key-value table apart from the issuer's header. */
  ocrWords?: readonly OcrWord[] | null;
}

export async function validateInvoice(
  invoiceId: string,
  tenantId: string,
  data: ExtractedData,
  rules: TenantRules,
  context: ValidationContext = {}
): Promise<{ data: ExtractedData; validationResult: ValidationResult; supplierRule: SupplierRuleTrace | null }> {
  // 1. Run edge cases & auto-corrections
  const { data: corrected, warnings: edgeWarnings } = runEdgeCaseHandlers(data);
  // Amounts the edge-case handlers rewrote (math fix or exempt-supplier guess) block auto-approve
  const amountsAutoCorrected = amountsChanged(data, corrected);
  const warnings = [...edgeWarnings];

  // Apply leading-zero padding to any extracted VAT ID if it has 8 digits
  if (corrected.supplier_vat_id) {
    let clean = corrected.supplier_vat_id.replace(/\D/g, '');
    if (clean.length === 8) {
      corrected.supplier_vat_id = '0' + clean;
    }
  }

  // 1.4 The supplier's VAT ID is the issuer's. An ID printed next to a buyer label ("לכבוד",
  // "ח.פ לקוח") or known to be the client's own ID is the buyer's: swap it for the issuer's ID on
  // the page, or remove it when there is no single candidate.
  const readVatId = corrected.supplier_vat_id || null;
  let buyerVatIdSuspected = false;
  if (readVatId) {
    const ownIds = await fetchClientOwnVatIds(supabase, tenantId, invoiceId, [normalizeVatId(readVatId) ?? readVatId]);
    const vatCheck = checkSupplierVatId({
      vatId: readVatId,
      ocrText: context.ocrText,
      ocrWords: context.ocrWords,
      clientOwnIds: ownIds,
    });
    if (vatCheck.reason) {
      buyerVatIdSuspected = true;
      console.log(`[Validation] supplier_vat_id ${readVatId} looks like the buyer's (${vatCheck.reason}); using ${vatCheck.replacement ?? 'none'}.`);
      corrected.supplier_vat_id = vatCheck.vatId;
      const warning = supplierVatIdWarning(readVatId, vatCheck);
      if (warning) warnings.push(warning);
    }
  }

  // 1.5 Fetch mapping if supplier name is known to override/fill the VAT ID
  const invoiceVatId = corrected.supplier_vat_id || null;
  let supplierTableVatId: string | null = null;
  let webSearchVatId: string | null = null;

  if (corrected.supplier_name) {
    // 1.5.1 Supplier Table Lookup
    try {
      const { data: mapping, error: mappingErr } = await supabase
        .from('account_mappings')
        .select('vat_id')
        .eq('client_id', tenantId)
        .eq('mapping_type', 'supplier')
        .eq('key', corrected.supplier_name)
        .maybeSingle();

      if (!mappingErr && mapping && mapping.vat_id) {
        const rawVat = mapping.vat_id;
        // Pad the mapping vat_id if it's 8 digits
        let cleanTableVat = rawVat.replace(/\D/g, '');
        if (cleanTableVat.length === 8) {
          supplierTableVatId = '0' + cleanTableVat;
        } else {
          supplierTableVatId = rawVat;
        }
      }
    } catch (err) {
      console.error('Failed to query account_mappings for supplier VAT ID fallback:', err);
    }

    // 1.5.2 Web Search Lookup (never for the catch-all placeholder name: any hit would be unrelated)
    if (!isGenericSupplierName(corrected.supplier_name)) try {
      const searchResult = await searchVatIdByName(corrected.supplier_name);
      if (searchResult) {
        // Pad the web search vat_id if it's 8 digits
        let cleanWeb = searchResult.replace(/\D/g, '');
        if (cleanWeb.length === 8) {
          webSearchVatId = '0' + cleanWeb;
        } else {
          webSearchVatId = searchResult;
        }
      }
    } catch (err) {
      console.error('Failed to search web for supplier VAT ID:', err);
    }
  }

  // Apply hierarchy to set the supplier_vat_id
  if (supplierTableVatId) {
    if (corrected.supplier_vat_id !== supplierTableVatId) {
      console.log(`[Validation] Correcting supplier_vat_id for "${corrected.supplier_name}" from "${corrected.supplier_vat_id}" to "${supplierTableVatId}" based on account mapping.`);
      corrected.supplier_vat_id = supplierTableVatId;
      warnings.push(`מספר ח.פ./עוסק מורשה עודכן אוטומטית ל-${supplierTableVatId} לפי הגדרות הספק המוכר`);
    }
  } else if (!corrected.supplier_vat_id && webSearchVatId) {
    console.log(`[Validation] Correcting supplier_vat_id for "${corrected.supplier_name}" to "${webSearchVatId}" based on web search.`);
    corrected.supplier_vat_id = webSearchVatId;
    warnings.push(`מספר ח.פ./עוסק מורשה עודכן אוטומטית ל-${webSearchVatId} לפי חיפוש באינטרנט`);
  }

  // 1.6 Supplier rule (client's supplier defaults). Applied to validated_data only by the save nodes;
  // the rule-dependent checks below (supplier name, category) run on the values the reviewer will see.
  const supplierMapping = findSupplierRule(await fetchSupplierMappings(supabase, tenantId), corrected);
  const { data: withRule } = applySupplierRule(corrected, corrected, supplierMapping);
  const supplierRule = withRule.supplier_rule ?? null;

  // 2. Perform baseline structural checks
  const mathOk = checkMath(corrected);
  const vatIdOk = checkVatId(corrected.supplier_vat_id);

  // Determine missing fields based on tenant rules & system defaults
  const missingFields: string[] = [];
  if (!withRule.supplier_name) missingFields.push('supplier_name');
  if (rules.requireVatId && !corrected.supplier_vat_id) missingFields.push('supplier_vat_id');
  if (rules.requireInvoiceDate && !corrected.invoice_date) missingFields.push('invoice_date');
  if (rules.requireExpenseCategory && !withRule.expense_category) missingFields.push('expense_category');
  
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
    withRule.expense_category &&
    rules.allowedExpenseCategories.length > 0 &&
    !rules.allowedExpenseCategories.includes(withRule.expense_category)
  ) {
    ruleViolations.push(`קטגוריית ההוצאה "${withRule.expense_category}" אינה מורשית עבור לקוח זה`);
  }

  // VAT ID requirement fallback
  if (rules.requireVatId && !vatIdOk) {
    ruleViolations.push('ח.פ. / עוסק מורשה אינו תקין לפי בדיקת checksum');
  }

  // Allocation number (חשבוניות ישראל) above the threshold
  corrected.allocation_number = normalizeAllocationNumber(corrected.allocation_number);
  const allocationRequired = isAllocationRequired(corrected);
  if (allocationRequired && !corrected.allocation_number) {
    ruleViolations.push(
      `חסר מספר הקצאה: חשבונית מעל ₪${allocationThreshold(corrected.invoice_date)} לפני מע"מ — בלי מספר הקצאה לא ניתן לקזז את המע"מ`
    );
  } else if (corrected.allocation_number && !isAllocationNumberWellFormed(corrected.allocation_number)) {
    warnings.push(`מספר ההקצאה ${corrected.allocation_number} אינו בן 9 ספרות — אנא ודא`);
  }

  // Line items (when extracted): sum vs. invoice amounts and mixed VAT — warnings only
  const lineItems = normalizeLineItems(corrected.line_items);
  corrected.line_items = lineItems.length > 0 ? lineItems : null;
  const lineItemsSumOk = checkLineItemsSum(corrected).ok;
  const mixedVat = hasMixedVat(lineItems);
  const lineItemsWarnings = lineItemWarnings(corrected);
  warnings.push(...lineItemsWarnings);

  // VAT vs. the statutory rate for the invoice date (18% from 2025, 17% before); VAT 0 is handled below
  const rateWarning = vatRateWarning(corrected);
  if (rateWarning) warnings.push(rateWarning);

  // Model confidences no longer apply to fields auto-corrected above (amounts, VAT ID from the supplier table)
  corrected.field_confidence = pruneFieldConfidence(data.field_confidence, data, corrected);
  if (!corrected.field_confidence) delete corrected.field_confidence;
  // Low model confidence blocks auto-approve, except for fields the supplier rule fills in
  const ruleFilled = new Set(Object.keys(supplierRule?.applied ?? {}));
  const lowConfidenceFields = CONFIDENCE_FIELDS.filter(
    (f) => !ruleFilled.has(f) && corrected[f] != null && isLowConfidence(fieldConfidence(corrected, f))
  );

  // 4. Duplicate checks: same file, same supplier + invoice number, or same supplier with
  // near-identical total and date (see src/shared/duplicates.ts). Rejected invoices and
  // pairs the reviewer dismissed are ignored.
  // duplicateCheckRan stays false when the check is off or fails, so auto-approve is blocked.
  let duplicateMatches: DuplicateMatch[] = [];
  let duplicateCheckRan = false;
  if (rules.duplicateInvoiceCheck) {
    try {
      duplicateMatches = await findDuplicatesForInvoice(supabase, tenantId, invoiceId, corrected);
      duplicateCheckRan = true;
      ruleViolations.push(...duplicateViolationMessages(duplicateMatches, corrected.invoice_number));
    } catch (err) {
      console.error('Failed to run duplicate invoice database check:', err);
    }
  }

  // 5. Detect if the document is not an invoice at all (missing all key structural fields)
  const notAnInvoice =
    !withRule.supplier_name &&
    !corrected.invoice_number &&
    !corrected.total_amount &&
    !corrected.amount_before_vat;

  // 6. Manual review is required unless the client opted this supplier into auto-approve AND every
  // check passed (math, VAT ID, required fields, rules, duplicates, document type).
  const supplierVatKey = normalizeVatId(corrected.supplier_vat_id);
  const optedIn = supplierVatKey ? await isAutoApproveEnabled(supabase, tenantId, supplierVatKey) : false;

  // VAT 0 ("exempt supplier"): guessed from a missing VAT amount, or contradicted by the supplier's
  // reviewed invoices that carried VAT -> warn and block auto-approve. A supplier whose history is
  // all VAT 0 (a real עוסק פטור) can still be auto-approved.
  const exemptGuessed = data.vat_amount == null && corrected.vat_amount === 0;
  let zeroVatContradictsHistory = false;
  let zeroVatHistoryUnknown = false;
  if (supplierVatKey && isZeroVatInvoice(corrected)) {
    const history = await fetchSupplierVatHistory(supabase, tenantId, supplierVatKey);
    if (!history) zeroVatHistoryUnknown = true;
    else if (history.withVatCount > 0) {
      zeroVatContradictsHistory = true;
      warnings.push(ZERO_VAT_WITH_HISTORY_WARNING);
    }
  }
  const blockers = optedIn
    ? autoApproveBlockers({
        supplierVatId: supplierVatKey,
        result: {
          math_ok: mathOk,
          vat_id_ok: vatIdOk,
          fields_missing: missingFields,
          rule_violations: ruleViolations,
          duplicate_found: duplicateMatches.length > 0,
          not_an_invoice: notAnInvoice,
        },
        duplicateCheckRan,
        amountsAutoCorrected,
        // The opt-in is keyed by VAT ID, so it must come from the invoice itself
        vatIdAutoFilled: normalizeVatId(invoiceVatId) !== supplierVatKey,
        lineItemWarnings: lineItemsWarnings,
        lowConfidenceFields,
        vatRateMismatch: rateWarning != null,
        exemptGuessed,
        zeroVatContradictsHistory,
        zeroVatHistoryUnknown,
        buyerVatIdSuspected,
      })
    : [];
  const autoApproved = optedIn && blockers.length === 0;
  const requiresManualReview = !autoApproved;
  if (optedIn) {
    console.log(
      autoApproved
        ? `[Validation] Supplier ${supplierVatKey} is opted into auto-approve and all checks passed: skipping manual review.`
        : `[Validation] Supplier ${supplierVatKey} is opted into auto-approve but needs review: ${blockers.join(' | ')}`
    );
  }

  const validationResult: ValidationResult = {
    math_ok: mathOk,
    vat_id_ok: vatIdOk,
    fields_missing: missingFields,
    duplicate_found: duplicateMatches.length > 0,
    duplicate_matches: duplicateMatches,
    rule_violations: ruleViolations,
    warnings,
    requires_manual_review: requiresManualReview,
    not_an_invoice: notAnInvoice,
    allocation_required: allocationRequired,
    auto_approved: autoApproved,
    ...(optedIn && !autoApproved ? { auto_approve_blockers: blockers } : {}),
    line_items_sum_ok: lineItemsSumOk,
    mixed_vat: mixedVat,
    vat_id_sources: {
      invoice: invoiceVatId,
      supplier_table: supplierTableVatId,
      web_search: webSearchVatId,
    },
  };

  return {
    data: {
      ...corrected,
      validation_flags: validationResult,
    },
    validationResult,
    supplierRule,
  };
}
