import type { DuplicateMatch, ExtractedData, OcrWord, SupplierRuleTrace, TenantRules, ValidationResult } from '@/shared/types';
import { CREDIT_NOTE_WARNING, MISSING_DATE_WARNING } from '@/shared/reviewWarnings';
import { supabase } from '@/lib/supabase';
import { fetchSupplierMappings, isAutoApproveEnabled } from '@/lib/supplierAutomation';
import { applySupplierRule, findSupplierRule, isGenericSupplierName, normalizeVatId } from '@/shared/supplierRules';
import { amountsChanged, autoApproveBlockers } from '@/shared/autoApprove';
import { findDuplicatesForInvoice } from '@/lib/duplicates';
import { duplicateViolationMessages } from '@/shared/duplicates';
import { lookupVatIdByName, REGISTRAR_UNAVAILABLE_WARNING, type VatLookupStatus } from '@/utils/businessLookup';
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
import { checkAmountSanity } from '@/shared/amountSanity';
import { checkInvoiceDateSanity, DATE_SANITY_WARNING, IMPLAUSIBLE_DATE_CONFIDENCE } from '@/shared/dateSanity';
import {
  BUYER_VAT_UNRESOLVED_VIOLATION,
  checkSupplierVatId,
  findVatIdOccurrences,
  findVatIdOccurrencesFromWords,
  supplierVatIdWarning,
  type SupplierVatIdCheck,
} from '@/shared/buyerVatId';
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
    warnings.push(CREDIT_NOTE_WARNING);
  }

  // 4. Missing Date
  if (current.invoice_date == null) {
    warnings.push(MISSING_DATE_WARNING);
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
  /** When the document was uploaded (invoices.created_at); read from the invoice when not given. */
  uploadedAt?: string | Date | null;
}

/** invoices.created_at of the invoice, or null (the date sanity check then compares with today). */
async function invoiceUploadedAt(invoiceId: string): Promise<string | null> {
  try {
    // limit(1), not maybeSingle(): the local mock DB client doesn't implement maybeSingle
    const { data: rows } = await supabase.from('invoices').select('created_at').eq('id', invoiceId).limit(1);
    const row = (Array.isArray(rows) ? rows[0] : null) as { created_at?: string | null } | null;
    return row?.created_at ?? null;
  } catch {
    return null;
  }
}

export async function validateInvoice(
  invoiceId: string,
  tenantId: string,
  data: ExtractedData,
  rules: TenantRules,
  context: ValidationContext = {}
): Promise<{ data: ExtractedData; validationResult: ValidationResult; supplierRule: SupplierRuleTrace | null }> {
  // 0. Amount sanity: implausible amounts (round placeholders, large amounts the document doesn't
  // show, VAT mismatch on amounts not in the document) are removed or marked unconfirmed before
  // anything else uses them (auto-corrections, allocation-number rule, duplicates).
  const sanity = checkAmountSanity(data, context.ocrText);
  if (sanity.result) {
    console.log(
      `[Validation] Amount sanity (${sanity.result.action}: ${sanity.result.reasons.join(', ')}) on invoice ${invoiceId}; extracted ${JSON.stringify(sanity.result.original)}`
    );
  }

  // 1. Run edge cases & auto-corrections
  const { data: corrected, warnings: edgeWarnings } = runEdgeCaseHandlers(sanity.data);
  // Amounts the edge-case handlers rewrote (math fix or exempt-supplier guess) or the sanity layer removed block auto-approve
  const amountsAutoCorrected = amountsChanged(data, corrected);
  const warnings = [...(sanity.warning ? [sanity.warning] : []), ...edgeWarnings];

  // Apply leading-zero padding to any extracted VAT ID if it has 8 digits
  if (corrected.supplier_vat_id) {
    let clean = corrected.supplier_vat_id.replace(/\D/g, '');
    if (clean.length === 8) {
      corrected.supplier_vat_id = '0' + clean;
    }
  }

  // 1.4 Supplier table / registrar lookups by the supplier's name: they override / fill the VAT ID
  // below, and are the trusted replacement when the extracted ID turns out to be the buyer's (1.5).
  let supplierTableVatId: string | null = null;
  let webSearchVatId: string | null = null;
  let webSearchStatus: VatLookupStatus = 'skipped';

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
      const lookup = await lookupVatIdByName(corrected.supplier_name);
      webSearchStatus = lookup.status;
      const searchResult = lookup.vatId;
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
      webSearchStatus = 'unavailable';
      console.error('Failed to search web for supplier VAT ID:', err);
    }
  }
  // The registrar could not be asked (timeouts / errors, QA round 4): the supplier's VAT ID was not
  // cross-checked against it, which the reviewer should know (the supplier table, when it has the
  // supplier, is the stronger source anyway)
  if (webSearchStatus === 'unavailable' && !supplierTableVatId) warnings.push(REGISTRAR_UNAVAILABLE_WARNING);

  // 1.5 The supplier's VAT ID is the issuer's. An ID printed next to a buyer label ("לכבוד",
  // "ח.פ לקוח") or known to be the client's own ID is the buyer's: swap it for the issuer-labelled
  // ID on the page, else for the supplier table / registrar ID, else remove it and flag the invoice
  // for manual review (never for some other number on the page: those are transaction numbers).
  const readVatId = corrected.supplier_vat_id || null;
  let buyerVatIdSuspected = false;
  let vatReplacementSource: SupplierVatIdCheck['replacementSource'] = null;
  if (readVatId) {
    const ownIds = await fetchClientOwnVatIds(supabase, tenantId, invoiceId, [normalizeVatId(readVatId) ?? readVatId]);
    const vatCheck = checkSupplierVatId({
      vatId: readVatId,
      ocrText: context.ocrText,
      ocrWords: context.ocrWords,
      clientOwnIds: ownIds,
      lineItemTexts: (corrected.line_items ?? []).map((item) => item?.description),
      referenceIds: [supplierTableVatId, webSearchVatId],
    });
    if (vatCheck.reason) {
      buyerVatIdSuspected = true;
      vatReplacementSource = vatCheck.replacementSource;
      console.log(`[Validation] supplier_vat_id ${readVatId} looks like the buyer's (${vatCheck.reason}); using ${vatCheck.replacement ?? 'none'}.`);
      corrected.supplier_vat_id = vatCheck.vatId;
      const warning = supplierVatIdWarning(readVatId, vatCheck);
      if (warning) warnings.push(warning);
    }
  }

  // The ID as read from the invoice (after the buyer-ID check); a reference ID is not read from it
  const invoiceVatId = vatReplacementSource === 'reference' ? null : corrected.supplier_vat_id || null;

  // Apply hierarchy to set the supplier_vat_id
  if (supplierTableVatId) {
    if (corrected.supplier_vat_id !== supplierTableVatId) {
      console.log(`[Validation] Correcting supplier_vat_id for "${corrected.supplier_name}" from "${corrected.supplier_vat_id}" to "${supplierTableVatId}" based on account mapping.`);
      corrected.supplier_vat_id = supplierTableVatId;
      warnings.push(`מספר ח.פ./עוסק מורשה עודכן אוטומטית ל-${supplierTableVatId} לפי הגדרות הספק המוכר`);
    }
  } else if (!corrected.supplier_vat_id && webSearchVatId && !buyerVatIdSuspected) {
    // (After a buyer-ID suspicion the check above already decided whether the registrar ID is usable)
    console.log(`[Validation] Correcting supplier_vat_id for "${corrected.supplier_name}" to "${webSearchVatId}" based on web search.`);
    corrected.supplier_vat_id = webSearchVatId;
    warnings.push(`מספר ח.פ./עוסק מורשה עודכן אוטומטית ל-${webSearchVatId} לפי חיפוש באינטרנט`);
  }

  // Registrar cross-check (finding #15): the registrar number for the supplier's name is printed
  // on the page but differs from the extracted ID -> the extracted one is probably the buyer's (or
  // a misread). Swap when the extracted ID is not on the page at all; otherwise warn, mark the
  // field low-confidence and block auto-approve so a reviewer decides.
  let registrarVatConflict = false;
  if (!supplierTableVatId && webSearchVatId && corrected.supplier_vat_id) {
    const registrarId = normalizeVatId(webSearchVatId);
    const currentId = normalizeVatId(corrected.supplier_vat_id);
    if (registrarId && currentId && registrarId !== currentId) {
      const printed = new Set(
        [...findVatIdOccurrences(context.ocrText), ...findVatIdOccurrencesFromWords(context.ocrWords)].map((o) => o.vatId)
      );
      if (printed.has(registrarId)) {
        registrarVatConflict = true;
        if (!printed.has(currentId)) {
          console.log(`[Validation] supplier_vat_id ${currentId} is not on the page; using the registrar's ${registrarId}, which is.`);
          warnings.push(`ח.פ. שזוהה (${corrected.supplier_vat_id}) אינו מופיע במסמך — הוחלף ל-${registrarId} שמופיע במסמך ותואם לשם הספק ברשם. אנא ודא`);
          corrected.supplier_vat_id = registrarId;
        } else {
          console.log(`[Validation] supplier_vat_id ${currentId} differs from the registrar's ${registrarId} (also on the page): needs review.`);
          warnings.push(`ח.פ. שזוהה (${corrected.supplier_vat_id}) שונה מהמספר ${registrarId} שמופיע במסמך ותואם לשם הספק ברשם — ייתכן שזה המספר של הלקוח. אנא ודא`);
        }
      }
    }
  }

  // 1.6 Supplier rule (client's supplier defaults). Applied to validated_data only by the save nodes;
  // the rule-dependent checks below (supplier name, category) run on the values the reviewer will see.
  const supplierMapping = findSupplierRule(await fetchSupplierMappings(supabase, tenantId), corrected);
  const { data: withRule } = applySupplierRule(corrected, corrected, supplierMapping);
  const supplierRule = withRule.supplier_rule ?? null;

  // The buyer's ID was removed and nothing reliable replaced it: the VAT ID is not OK and the
  // invoice needs a reviewer, whether or not the supplier is opted in to auto-approve.
  const buyerVatIdUnresolved = buyerVatIdSuspected && !corrected.supplier_vat_id;

  // 2. Perform baseline structural checks
  const mathOk = checkMath(corrected);
  const vatIdChecksumOk = checkVatId(corrected.supplier_vat_id);
  const vatIdOk = vatIdChecksumOk && !buyerVatIdUnresolved;

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
  if (rules.requireVatId && !vatIdChecksumOk) {
    ruleViolations.push('ח.פ. / עוסק מורשה אינו תקין לפי בדיקת checksum');
  }
  if (buyerVatIdUnresolved) ruleViolations.push(BUYER_VAT_UNRESOLVED_VIOLATION);

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
  if (sanity.result?.action === 'unconfirmed' && sanity.data.field_confidence) {
    // Kept as a suggestion: the lowered scores from the sanity layer, not the model's
    corrected.field_confidence = { ...(corrected.field_confidence ?? {}) };
    for (const f of ['amount_before_vat', 'vat_amount', 'total_amount'] as const) {
      const v = sanity.data.field_confidence[f];
      if (v != null && corrected[f] === sanity.data[f]) corrected.field_confidence[f] = v;
    }
  }
  // Date sanity: a date far in the future or long before the upload (e.g. a year printed on the
  // receipt book read instead of the handwritten date) is kept, but highlighted as low confidence
  // (blocks auto-approve) with a warning. The review form drops the warning once the date is fixed.
  const uploadedAt = context.uploadedAt !== undefined ? context.uploadedAt : await invoiceUploadedAt(invoiceId);
  const dateSanity = checkInvoiceDateSanity(corrected.invoice_date, uploadedAt);
  if (dateSanity) {
    console.log(`[Validation] Implausible invoice date (${dateSanity.reason}) on invoice ${invoiceId}: ${dateSanity.original} vs. upload ${dateSanity.reference_date}`);
    const prev = corrected.field_confidence?.invoice_date;
    corrected.field_confidence = {
      ...(corrected.field_confidence ?? {}),
      invoice_date: Math.min(prev ?? IMPLAUSIBLE_DATE_CONFIDENCE, IMPLAUSIBLE_DATE_CONFIDENCE),
    };
    warnings.push(DATE_SANITY_WARNING);
  }
  if (!corrected.field_confidence) delete corrected.field_confidence;
  if ((registrarVatConflict || (buyerVatIdSuspected && vatReplacementSource === 'reference')) && corrected.supplier_vat_id) {
    // The model's (often 0.95) score is not evidence against the registrar: highlight the field
    const prev = corrected.field_confidence?.supplier_vat_id;
    corrected.field_confidence = { ...(corrected.field_confidence ?? {}), supplier_vat_id: Math.min(prev ?? 0.5, 0.5) };
  }
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
    !corrected.amount_before_vat &&
    // Amounts the sanity layer removed still show the document was read as an invoice: review, not error
    !sanity.result?.original.total_amount &&
    !sanity.result?.original.amount_before_vat;

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
        buyerVatIdSuspected: buyerVatIdSuspected || registrarVatConflict,
        implausibleDate: dateSanity != null,
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
    ...(sanity.result ? { amount_sanity: sanity.result } : {}),
    ...(dateSanity ? { date_sanity: dateSanity } : {}),
    ...(optedIn && !autoApproved ? { auto_approve_blockers: blockers } : {}),
    line_items_sum_ok: lineItemsSumOk,
    mixed_vat: mixedVat,
    vat_id_sources: {
      invoice: invoiceVatId,
      supplier_table: supplierTableVatId,
      web_search: webSearchVatId,
      web_search_status: webSearchStatus,
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
