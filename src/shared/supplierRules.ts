// Supplier rules (per client + supplier defaults), stored as account_mappings rows of type 'supplier':
//   key              -> canonical supplier name (the export resolves the ledger account code by it)
//   account_code     -> supplier ledger account
//   vat_id           -> supplier VAT ID (preferred match key)
//   expense_category -> default expense category
//
// Precedence for a field on an invoice (validated_data only, extracted_data is never touched):
//   1. explicit reviewer edit on the invoice
//   2. supplier rule
//   3. AI extraction
// The rule-filled values are recorded in validated_data.supplier_rule so a later re-apply can tell a
// rule-filled value (safe to overwrite) from a reviewer edit (kept).
import type { AccountMapping, ExtractedData, SupplierRuleField, SupplierRuleTrace } from '@/shared/types';

/** Ledger account of the catch-all supplier (ספקים שונים). */
export const VARIOUS_SUPPLIERS_ACCOUNT = '3499';
export const VARIOUS_SUPPLIERS_NAME = 'ספקים שונים';

/** Placeholder names that stand for "some supplier", not a real business (never looked up in the registrar). */
const GENERIC_SUPPLIER_NAME_KEYS = new Set([VARIOUS_SUPPLIERS_NAME, 'ספק כללי', 'ספקים כלליים', 'ספק שונה', 'שונים'].map(
  (n) => n.replace(/\s+/g, ' ').trim()
));

/** True for the catch-all supplier name (ספקים שונים) and similar placeholders. */
export function isGenericSupplierName(name: string | null | undefined): boolean {
  if (!name) return false;
  return GENERIC_SUPPLIER_NAME_KEYS.has(String(name).replace(/["'״׳.]/g, '').replace(/\s+/g, ' ').trim());
}

export const SUPPLIER_RULE_FIELDS: readonly SupplierRuleField[] = ['supplier_name', 'expense_category'];

/** Digits only, 8-digit IDs padded to 9 (same convention as validation). Null when empty. */
export function normalizeVatId(vatId: string | null | undefined): string | null {
  if (!vatId) return null;
  const digits = String(vatId).replace(/\D/g, '');
  if (!digits) return null;
  return digits.length === 8 ? `0${digits}` : digits;
}

function normalizeText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const s = String(value).trim().replace(/\s+/g, ' ');
  return s === '' ? null : s;
}

/**
 * Finds the supplier rule for an invoice. A VAT ID match wins over a name match (names vary between
 * invoices of the same supplier); among VAT matches, one whose name also matches is preferred.
 */
export function findSupplierRule(
  mappings: readonly AccountMapping[],
  invoice: { supplier_name?: string | null; supplier_vat_id?: string | null }
): AccountMapping | null {
  const suppliers = mappings.filter((m) => m.mapping_type === 'supplier');
  const vatId = normalizeVatId(invoice.supplier_vat_id);
  const name = normalizeText(invoice.supplier_name);

  if (vatId) {
    const byVat = suppliers.filter((m) => normalizeVatId(m.vat_id) === vatId);
    if (byVat.length > 0) return byVat.find((m) => normalizeText(m.key) === name) ?? byVat[0];
  }
  if (!name) return null;
  return suppliers.find((m) => normalizeText(m.key) === name) ?? null;
}

/** The invoice field values a supplier rule sets. */
export function supplierRuleValues(mapping: AccountMapping): Partial<Record<SupplierRuleField, string>> {
  const values: Partial<Record<SupplierRuleField, string>> = {};
  // Canonical name so the export finds the supplier's ledger account. Suppliers booked to the
  // catch-all account get the review form's 'ספקים שונים' name.
  const key = normalizeText(mapping.key);
  if (mapping.account_code === VARIOUS_SUPPLIERS_ACCOUNT) values.supplier_name = VARIOUS_SUPPLIERS_NAME;
  else if (key) values.supplier_name = key;
  const category = normalizeText(mapping.expense_category);
  if (category) values.expense_category = category;
  return values;
}

export interface SupplierRuleOutcome {
  data: ExtractedData;
  changed: SupplierRuleField[];
}

/**
 * Applies (or re-applies) a supplier rule to an invoice's current validated data.
 * - aiData:  the AI extraction (extracted_data), the fallback when a rule stops setting a field
 * - current: validated_data as it is now (may carry a previous supplier_rule trace)
 * - mapping: the rule that matches now, or null (rule deleted / no longer matches)
 * Never mutates its inputs.
 */
export function applySupplierRule(
  aiData: Partial<ExtractedData> | null | undefined,
  current: ExtractedData,
  mapping: AccountMapping | null,
  now: string = new Date().toISOString()
): SupplierRuleOutcome {
  const next: ExtractedData = { ...current };
  const previous = current.supplier_rule?.applied ?? {};
  const ruleValues = mapping ? supplierRuleValues(mapping) : {};
  const applied: Partial<Record<SupplierRuleField, string>> = {};
  const changed: SupplierRuleField[] = [];

  for (const field of SUPPLIER_RULE_FIELDS) {
    const currentValue = normalizeText(current[field]);
    const aiValue = normalizeText(aiData?.[field]);
    const previousRuleValue = previous[field];

    // A value that is neither the AI's nor what a rule filled in was set by the reviewer: keep it.
    const reviewerEdit =
      currentValue !== aiValue &&
      (previousRuleValue === undefined || currentValue !== normalizeText(previousRuleValue));
    if (reviewerEdit) continue;

    const ruleValue = ruleValues[field];
    if (ruleValue !== undefined) {
      next[field] = ruleValue;
      applied[field] = ruleValue;
      if (currentValue !== ruleValue) changed.push(field);
    } else if (previousRuleValue !== undefined) {
      // The rule no longer sets this field: fall back to the AI value.
      next[field] = aiData?.[field] ?? null;
      if (currentValue !== aiValue) changed.push(field);
    }
  }

  next.supplier_rule =
    mapping && Object.keys(applied).length > 0
      ? { mapping_id: mapping.id ?? null, applied, applied_at: now }
      : null;

  // Don't keep flagging a required field as missing once the rule filled it.
  const flags = next.validation_flags;
  if (flags && changed.length > 0) {
    const filled = changed.filter((f) => normalizeText(next[f]) !== null);
    if (filled.length > 0 && flags.fields_missing.some((f) => (filled as string[]).includes(f))) {
      next.validation_flags = {
        ...flags,
        fields_missing: flags.fields_missing.filter((f) => !(filled as string[]).includes(f)),
      };
    }
  }

  // The model's confidence was about the AI value, not the rule's
  next.field_confidence = withoutConfidenceFor(next.field_confidence, changed);
  if (!next.field_confidence) delete next.field_confidence;

  return { data: next, changed };
}

function withoutConfidenceFor(
  confidence: ExtractedData['field_confidence'],
  fields: readonly string[]
): ExtractedData['field_confidence'] {
  if (!confidence || fields.length === 0) return confidence;
  const rest = Object.fromEntries(Object.entries(confidence).filter(([f]) => !fields.includes(f)));
  return Object.keys(rest).length > 0 ? rest : undefined;
}

/** Writes an already computed trace onto data (used by the pipeline save nodes). */
export function withSupplierRule(data: ExtractedData, trace: SupplierRuleTrace | null | undefined): ExtractedData {
  if (!trace) return data;
  const next: ExtractedData = { ...data, ...trace.applied, supplier_rule: trace };
  // The model's confidence was about the AI value, not the rule's
  const changed = (Object.keys(trace.applied) as SupplierRuleField[]).filter((f) => data[f] !== trace.applied[f]);
  next.field_confidence = withoutConfidenceFor(data.field_confidence, changed);
  if (!next.field_confidence) delete next.field_confidence;
  return next;
}

/**
 * What the system proposed to the reviewer: the AI output with the supplier rule's values on top.
 * Corrections are measured against this, so a rule-filled value the reviewer accepted is not a
 * correction (it would otherwise block auto-approve for every supplier with a rule).
 */
export function systemProposal(
  aiData: Partial<ExtractedData> | null | undefined,
  validatedData: Partial<ExtractedData> | null | undefined
): Partial<ExtractedData> | null | undefined {
  const applied = validatedData?.supplier_rule?.applied;
  if (!aiData || !applied || Object.keys(applied).length === 0) return aiData;
  return { ...aiData, ...applied };
}
