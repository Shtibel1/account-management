// DB side of learning from corrections (logic in src/shared/learning.ts).
// Tables: extraction_learning_signals (one row per corrected field of an approved invoice) and
// extraction_learned_rules (one row per office + client + supplier + field), migration
// 20261031131000_learning_from_corrections.sql. Everything here is best-effort: learning must never
// block an approval or an extraction.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ExtractedData } from '@/shared/types';
import { findVatIdCandidates } from '@/shared/fewshot';
import {
  classifyCorrection,
  decideRule,
  isLearnableField,
  normalizeSupplierName,
  selectRulesForDocument,
  supplierKey,
  type Classification,
  type LearnedRule,
  type LearningSignal,
} from '@/shared/learning';
import { normalizeVatId } from '@/shared/vatId';

const SIGNALS = 'extraction_learning_signals';
const RULES = 'extraction_learned_rules';
/** Rules loaded for one extraction (per query). */
const RULES_QUERY_LIMIT = 50;

export const RULE_COLUMNS =
  'id, org_id, client_id, supplier_key, supplier_vat_id, supplier_name, field, label, wrong_label, line_offset, value_shape, support, conflicts, active, last_value, last_wrong_value, created_at, updated_at';

export interface CorrectionInput {
  field: string;
  ai_value: string | number | null;
  corrected_value: string | number | null;
}

export interface LearningOutcome {
  in_document: string[];
  not_in_document: string[];
  user_typo: string[];
  /** Rules created / updated / removed by this approval. */
  rules: { field: string; active: boolean; support: number; conflicts: number; removed?: boolean }[];
}

const EMPTY_OUTCOME: LearningOutcome = { in_document: [], not_in_document: [], user_typo: [], rules: [] };

function asText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value);
  return s === '' ? null : s.slice(0, 500);
}

async function clientOrg(db: SupabaseClient, clientId: string): Promise<string | null> {
  const { data, error } = await db.from('clients').select('org_id').eq('id', clientId).single();
  if (error || !data) return null;
  return ((data as { org_id: string | null }).org_id) ?? null;
}

interface RuleKey {
  org_id: string;
  client_id: string;
  supplier_key: string;
  field: string;
}

/** Recomputes (creates / updates / deletes) the rule of one key from its in-document signals. */
async function recomputeRule(
  db: SupabaseClient,
  key: RuleKey,
  supplier: { vat: string | null; name: string | null }
): Promise<LearningOutcome['rules'][number] | null> {
  const { data: signalRows, error } = await db
    .from(SIGNALS)
    .select('label, wrong_label, line_offset, value_shape, corrected_value, ai_value, created_at')
    .eq('org_id', key.org_id)
    .eq('client_id', key.client_id)
    .eq('supplier_key', key.supplier_key)
    .eq('field', key.field)
    .eq('classification', 'in_document')
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw new Error(`signals query failed: ${error.message}`);

  const { data: existingRows, error: ruleError } = await db
    .from(RULES)
    .select('id, label')
    .eq('org_id', key.org_id)
    .eq('client_id', key.client_id)
    .eq('supplier_key', key.supplier_key)
    .eq('field', key.field)
    .limit(1);
  if (ruleError) throw new Error(`rule query failed: ${ruleError.message}`);
  const existing = ((existingRows ?? []) as { id: string; label: string }[])[0] ?? null;

  const decision = decideRule((signalRows ?? []) as LearningSignal[], existing?.label ?? null);
  if (!decision) {
    if (existing) {
      await db.from(RULES).delete().eq('id', existing.id);
      return { field: key.field, active: false, support: 0, conflicts: 0, removed: true };
    }
    return null;
  }
  const row = {
    ...key,
    supplier_vat_id: supplier.vat,
    supplier_name: supplier.name,
    ...decision,
    updated_at: new Date().toISOString(),
  };
  if (existing) {
    const { error: updateError } = await db.from(RULES).update(row).eq('id', existing.id);
    if (updateError) throw new Error(`rule update failed: ${updateError.message}`);
  } else {
    const { error: insertError } = await db.from(RULES).insert(row);
    if (insertError) throw new Error(`rule insert failed: ${insertError.message}`);
  }
  return { field: key.field, active: decision.active, support: decision.support, conflicts: decision.conflicts };
}

/**
 * After an approval: classifies every corrected field (in the document / not / reviewer typo),
 * stores the signals of this invoice (replacing those of an earlier approval) and recomputes the
 * rules they touch. Never throws.
 */
export async function recordLearningSignals(
  db: SupabaseClient,
  invoiceId: string,
  input: {
    clientId: string;
    approvedData: Partial<ExtractedData>;
    before: Partial<ExtractedData> | null;
    corrections: CorrectionInput[];
  }
): Promise<LearningOutcome> {
  try {
    const { data: inv, error: invError } = await db.from('invoices').select('ocr_text').eq('id', invoiceId).single();
    if (invError) throw new Error(`invoice query failed: ${invError.message}`);
    const ocrText = (inv as { ocr_text: string | null } | null)?.ocr_text ?? null;
    const orgId = await clientOrg(db, input.clientId);
    if (!orgId) throw new Error('client has no office');

    const vat = normalizeVatId(asText(input.approvedData.supplier_vat_id ?? input.before?.supplier_vat_id));
    const name = normalizeSupplierName(input.approvedData.supplier_name ?? input.before?.supplier_name);
    const supplier = supplierKey(vat, name);

    // Keys of the previous approval's signals must be recomputed too (they are replaced below)
    const { data: oldRows, error: oldError } = await db
      .from(SIGNALS)
      .select('supplier_key, field, supplier_vat_id, supplier_name')
      .eq('invoice_id', invoiceId);
    if (oldError) throw new Error(`old signals query failed: ${oldError.message}`);
    const old = (oldRows ?? []) as { supplier_key: string; field: string; supplier_vat_id: string | null; supplier_name: string | null }[];

    const classified: Classification[] = input.corrections.map((c) => classifyCorrection(c.field, c.ai_value, c.corrected_value, ocrText));
    const outcome: LearningOutcome = { in_document: [], not_in_document: [], user_typo: [], rules: [] };
    for (const c of classified) outcome[c.classification].push(c.field);

    await db.from(SIGNALS).delete().eq('invoice_id', invoiceId);
    if (supplier && classified.length > 0) {
      const now = new Date().toISOString();
      const rows = classified.map((c, i) => ({
        org_id: orgId,
        client_id: input.clientId,
        invoice_id: invoiceId,
        supplier_key: supplier,
        supplier_vat_id: vat && vat.length === 9 ? vat : null,
        supplier_name: name,
        field: c.field,
        classification: c.classification,
        reason: c.reason,
        ai_value: asText(input.corrections[i].ai_value),
        corrected_value: asText(input.corrections[i].corrected_value),
        label: c.label,
        wrong_label: c.wrongLabel,
        line_offset: c.lineOffset,
        value_shape: c.shape,
        created_at: now,
      }));
      const { error: insertError } = await db.from(SIGNALS).insert(rows);
      if (insertError) throw new Error(`signals insert failed: ${insertError.message}`);
    }

    const keys = new Map<string, { key: RuleKey; vat: string | null; name: string | null }>();
    const add = (supplierKeyValue: string, field: string, v: string | null, n: string | null) => {
      if (!isLearnableField(field)) return;
      const key = { org_id: orgId, client_id: input.clientId, supplier_key: supplierKeyValue, field };
      keys.set(`${supplierKeyValue}|${field}`, { key, vat: v, name: n });
    };
    for (const o of old) add(o.supplier_key, o.field, o.supplier_vat_id, o.supplier_name);
    if (supplier) {
      for (const c of classified) if (c.classification === 'in_document') add(supplier, c.field, vat && vat.length === 9 ? vat : null, name);
    }
    for (const { key, vat: v, name: n } of keys.values()) {
      const r = await recomputeRule(db, key, { vat: v, name: n });
      if (r) outcome.rules.push(r);
    }
    if (outcome.in_document.length + outcome.user_typo.length > 0) {
      console.log(`[learning] Invoice ${invoiceId}: in document ${outcome.in_document.join(',') || '-'}, not in document ${outcome.not_in_document.join(',') || '-'}, typo ${outcome.user_typo.join(',') || '-'}; rules ${JSON.stringify(outcome.rules)}`);
    }
    return outcome;
  } catch (err) {
    console.error(`[learning] Failed to record learning signals of invoice ${invoiceId}:`, err);
    return EMPTY_OUTCOME;
  }
}

/**
 * Active rules of the client's office that may apply to this document (supplier VAT id or name
 * printed in it), the client's own rules first. Throws on DB errors (callers wrap it).
 */
export async function loadLearnedRules(
  db: SupabaseClient,
  params: { clientId: string; ocrText: string | null }
): Promise<LearnedRule[]> {
  if (!params.ocrText?.trim()) return [];
  const orgId = await clientOrg(db, params.clientId);
  if (!orgId) return [];
  const keys = findVatIdCandidates(params.ocrText).map((c) => `vat:${c}`);
  const [byVat, byName] = await Promise.all([
    keys.length > 0
      ? db.from(RULES).select(RULE_COLUMNS).eq('org_id', orgId).eq('active', true).in('supplier_key', keys).limit(RULES_QUERY_LIMIT)
      : Promise.resolve({ data: [], error: null }),
    db.from(RULES).select(RULE_COLUMNS).eq('org_id', orgId).eq('active', true).is('supplier_vat_id', null).limit(RULES_QUERY_LIMIT),
  ]);
  if (byVat.error) throw new Error(`rules query failed: ${byVat.error.message}`);
  if (byName.error) throw new Error(`rules query failed: ${byName.error.message}`);
  const rows = [...((byVat.data ?? []) as LearnedRule[]), ...((byName.data ?? []) as LearnedRule[])];
  return selectRulesForDocument(rows, params.clientId, params.ocrText);
}

/** Forgets a rule: deletes it and the signals it was learned from (so the next approval doesn't bring it back). */
export async function forgetRule(
  db: SupabaseClient,
  rule: { id: string; org_id: string; client_id: string; supplier_key: string; field: string }
): Promise<void> {
  const { error: signalsError } = await db
    .from(SIGNALS)
    .delete()
    .eq('org_id', rule.org_id)
    .eq('client_id', rule.client_id)
    .eq('supplier_key', rule.supplier_key)
    .eq('field', rule.field);
  if (signalsError) throw new Error(`signals delete failed: ${signalsError.message}`);
  const { error } = await db.from(RULES).delete().eq('id', rule.id);
  if (error) throw new Error(`rule delete failed: ${error.message}`);
}
