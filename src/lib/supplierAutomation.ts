import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  AccountMapping,
  ExtractedData,
  SupplierAutomation,
  SupplierAutomationStatus,
  SupplierEligibility,
} from '@/shared/types';
import { applySupplierRule, findSupplierRule, normalizeVatId } from '@/shared/supplierRules';
import { computeSupplierEligibility, type ReviewedInvoiceRef } from '@/shared/autoApprove';
import type { FieldCorrection } from '@/lib/corrections';

// DB access for supplier rules and per-supplier auto-approve. Takes the client as a parameter
// (like corrections.ts) and only uses query-builder calls the local mock DB also supports
// (eq / in / order / select / insert / update), so it degrades to "no rules / not opted in"
// when the tables are missing.

export class SupplierNotEligibleError extends Error {
  constructor(public readonly eligibility: SupplierEligibility | null) {
    super('הספק אינו כשיר לאישור אוטומטי');
    this.name = 'SupplierNotEligibleError';
  }
}

/** All supplier rules (account_mappings of type 'supplier') of a client. Never throws. */
export async function fetchSupplierMappings(db: SupabaseClient, clientId: string): Promise<AccountMapping[]> {
  try {
    const { data, error } = await db
      .from('account_mappings')
      .select('*')
      .eq('client_id', clientId)
      .eq('mapping_type', 'supplier');
    if (error) throw error;
    return (data as AccountMapping[] | null) ?? [];
  } catch (err) {
    console.error(`[supplierAutomation] Failed to load supplier rules for client ${clientId}:`, err);
    return [];
  }
}

/** Opt-in row for a client + supplier, or null. Never throws (missing table = not opted in). */
export async function getSupplierAutomation(
  db: SupabaseClient,
  clientId: string,
  supplierVatId: string
): Promise<SupplierAutomation | null> {
  try {
    const { data, error } = await db
      .from('supplier_automation')
      .select('*')
      .eq('client_id', clientId)
      .eq('supplier_vat_id', supplierVatId);
    if (error) throw error;
    const rows = (data as SupplierAutomation[] | null) ?? [];
    return rows[0] ?? null;
  } catch (err) {
    console.error(`[supplierAutomation] Failed to read auto-approve opt-in for ${supplierVatId}:`, err);
    return null;
  }
}

/** Fails closed: any error means "not opted in". */
export async function isAutoApproveEnabled(db: SupabaseClient, clientId: string, supplierVatId: string): Promise<boolean> {
  const row = await getSupplierAutomation(db, clientId, supplierVatId);
  return row?.auto_approve === true;
}

interface ReviewedInvoiceRow {
  id: string;
  reviewed_at: string | null;
  // PostgREST JSON-path aliases (see select below)...
  vat_id?: string | null;
  ai_vat_id?: string | null;
  // ...the mock DB ignores the column list and returns whole rows.
  validated_data?: ExtractedData | null;
  extracted_data?: ExtractedData | null;
}

/** Eligibility for every supplier of a client that has human-reviewed invoices. */
export async function computeClientEligibility(
  db: SupabaseClient,
  clientId: string
): Promise<Map<string, SupplierEligibility>> {
  const { data: invoices, error } = await db
    .from('invoices')
    .select('id, reviewed_at, vat_id:validated_data->>supplier_vat_id, ai_vat_id:extracted_data->>supplier_vat_id')
    .eq('client_id', clientId)
    .in('status', ['approved', 'exported']);
  if (error) throw new Error(`Failed to load reviewed invoices: ${error.message}`);

  const reviewed: ReviewedInvoiceRef[] = [];
  for (const row of (invoices as ReviewedInvoiceRow[] | null) ?? []) {
    // Auto-approved invoices have no reviewed_at and don't count.
    if (!row.reviewed_at) continue;
    const vatId = normalizeVatId(
      row.vat_id ?? row.validated_data?.supplier_vat_id ?? row.ai_vat_id ?? row.extracted_data?.supplier_vat_id
    );
    reviewed.push({ invoice_id: row.id, supplier_vat_id: vatId, reviewed_at: row.reviewed_at });
  }

  const corrected = new Set<string>();
  if (reviewed.length > 0) {
    const { data: corrections, error: corrError } = await db
      .from('invoice_corrections')
      .select('invoice_id')
      .eq('client_id', clientId);
    if (corrError) throw new Error(`Failed to load corrections: ${corrError.message}`);
    for (const c of (corrections as { invoice_id: string }[] | null) ?? []) corrected.add(c.invoice_id);
  }

  return computeSupplierEligibility(reviewed, corrected);
}

/** Eligibility + opt-in state per supplier VAT ID, for the mappings page. */
export async function fetchSupplierAutomationStatus(
  db: SupabaseClient,
  clientId: string
): Promise<SupplierAutomationStatus[]> {
  const eligibility = await computeClientEligibility(db, clientId);

  let optIns: SupplierAutomation[] = [];
  try {
    const { data, error } = await db.from('supplier_automation').select('*').eq('client_id', clientId);
    if (error) throw error;
    optIns = (data as SupplierAutomation[] | null) ?? [];
  } catch (err) {
    // Table not migrated yet: show eligibility only.
    console.error(`[supplierAutomation] Failed to read auto-approve opt-ins for client ${clientId}:`, err);
  }

  const statuses = new Map<string, SupplierAutomationStatus>();
  for (const e of eligibility.values()) {
    statuses.set(e.supplier_vat_id, { ...e, auto_approve: false, disabled_reason: null, disabled_at: null });
  }
  for (const o of optIns) {
    const vatId = normalizeVatId(o.supplier_vat_id);
    if (!vatId) continue;
    const base = statuses.get(vatId) ?? {
      supplier_vat_id: vatId,
      reviewed_count: 0,
      clean_streak: 0,
      eligible: false,
    };
    statuses.set(vatId, {
      ...base,
      auto_approve: o.auto_approve === true,
      disabled_reason: o.disabled_reason ?? null,
      disabled_at: o.disabled_at ?? null,
    });
  }
  return [...statuses.values()];
}

/** Turns the opt-in on (only for an eligible supplier) or off. Returns the stored row. */
export async function setSupplierAutoApprove(
  db: SupabaseClient,
  clientId: string,
  rawSupplierVatId: string,
  enabled: boolean
): Promise<SupplierAutomation> {
  const supplierVatId = normalizeVatId(rawSupplierVatId);
  if (!supplierVatId) throw new Error('ח.פ. ספק אינו תקין');

  if (enabled) {
    const eligibility = (await computeClientEligibility(db, clientId)).get(supplierVatId) ?? null;
    if (!eligibility?.eligible) throw new SupplierNotEligibleError(eligibility);
  }

  const now = new Date().toISOString();
  const changes = enabled
    ? { auto_approve: true, enabled_at: now, disabled_at: null, disabled_reason: null, disabled_by_invoice_id: null, updated_at: now }
    : { auto_approve: false, disabled_at: now, disabled_reason: 'manual', disabled_by_invoice_id: null, updated_at: now };

  const existing = await getSupplierAutomation(db, clientId, supplierVatId);
  const { data, error } = existing
    ? await db.from('supplier_automation').update(changes).eq('id', existing.id).select().single()
    : await db
        .from('supplier_automation')
        .insert({ client_id: clientId, supplier_vat_id: supplierVatId, ...changes })
        .select()
        .single();
  if (error || !data) {
    throw new Error(`Failed to save auto-approve setting: ${error?.message ?? 'no row returned'}`);
  }
  return data as SupplierAutomation;
}

/**
 * Auto-revert: a human review of an opted-in supplier that needed corrections turns the opt-in off.
 * Never throws: must not block an approval.
 */
export async function disableAutoApproveAfterCorrections(
  db: SupabaseClient,
  invoiceId: string,
  approvedData: Partial<ExtractedData>,
  corrections: readonly FieldCorrection[]
): Promise<boolean> {
  if (corrections.length === 0) return false;
  try {
    const { data: invoice, error } = await db
      .from('invoices')
      .select('client_id, extracted_data')
      .eq('id', invoiceId)
      .single();
    if (error || !invoice) throw error ?? new Error('Invoice not found');

    const supplierVatId = normalizeVatId(approvedData.supplier_vat_id ?? invoice.extracted_data?.supplier_vat_id);
    if (!supplierVatId) return false;

    const optIn = await getSupplierAutomation(db, invoice.client_id, supplierVatId);
    if (!optIn?.auto_approve) return false;

    const now = new Date().toISOString();
    const { error: updateError } = await db
      .from('supplier_automation')
      .update({
        auto_approve: false,
        disabled_at: now,
        disabled_reason: 'corrections',
        disabled_by_invoice_id: invoiceId,
        updated_at: now,
      })
      .eq('id', optIn.id);
    if (updateError) throw updateError;

    console.log(`[supplierAutomation] Auto-approve turned off for supplier ${supplierVatId}: invoice ${invoiceId} needed ${corrections.length} correction(s).`);
    return true;
  } catch (err) {
    console.error(`[supplierAutomation] Failed to auto-revert auto-approve after invoice ${invoiceId}:`, err);
    return false;
  }
}

export interface SupplierRef {
  name?: string | null;
  vatId?: string | null;
}

interface ReviewInvoiceRow {
  id: string;
  extracted_data: ExtractedData | null;
  validated_data: ExtractedData | null;
}

/**
 * Re-applies the client's current supplier rules to its invoices still in 'review'.
 * Only validated_data changes; reviewer edits are kept (see applySupplierRule).
 * suppliers limits the run to invoices of those suppliers (old + new name / VAT ID of an edited
 * rule); omit it to re-apply to every invoice in review (e.g. after an Excel import).
 */
export async function reapplySupplierRules(
  db: SupabaseClient,
  clientId: string,
  suppliers?: readonly SupplierRef[]
): Promise<{ checked: number; updated: number }> {
  const names = new Set((suppliers ?? []).map((s) => s.name?.trim()).filter((n): n is string => !!n));
  const vatIds = new Set((suppliers ?? []).map((s) => normalizeVatId(s.vatId)).filter((v): v is string => !!v));

  const { data: invoices, error } = await db
    .from('invoices')
    .select('id, extracted_data, validated_data')
    .eq('client_id', clientId)
    .eq('status', 'review');
  if (error) throw new Error(`Failed to load invoices in review: ${error.message}`);

  const candidates = ((invoices as ReviewInvoiceRow[] | null) ?? []).filter((inv) => {
    if (!suppliers) return true;
    const ai = inv.extracted_data;
    const current = inv.validated_data;
    return (
      [ai?.supplier_name, current?.supplier_name].some((n) => !!n && names.has(n.trim())) ||
      [ai?.supplier_vat_id, current?.supplier_vat_id].some((v) => {
        const id = normalizeVatId(v);
        return !!id && vatIds.has(id);
      })
    );
  });
  if (candidates.length === 0) return { checked: 0, updated: 0 };

  const mappings = await fetchSupplierMappings(db, clientId);
  const now = new Date().toISOString();
  let updated = 0;

  for (const inv of candidates) {
    const current = inv.validated_data ?? inv.extracted_data;
    if (!current) continue;
    // Match on the VAT ID as validated (it may have been fixed from the supplier table) and the
    // name the AI read (validated supplier_name may already be the rule's canonical name).
    const mapping = findSupplierRule(mappings, {
      supplier_name: inv.extracted_data?.supplier_name ?? current.supplier_name,
      supplier_vat_id: current.supplier_vat_id ?? inv.extracted_data?.supplier_vat_id,
    });
    const { data: next, changed } = applySupplierRule(inv.extracted_data, current, mapping, now);
    const traceChanged = JSON.stringify(next.supplier_rule?.applied ?? null) !== JSON.stringify(current.supplier_rule?.applied ?? null);
    if (changed.length === 0 && !traceChanged) continue;

    const { error: updateError } = await db
      .from('invoices')
      .update({ validated_data: next, updated_at: now })
      .eq('id', inv.id)
      .eq('status', 'review'); // don't touch an invoice approved meanwhile
    if (updateError) {
      console.error(`[supplierAutomation] Failed to re-apply supplier rule to invoice ${inv.id}:`, updateError);
      continue;
    }
    if (changed.length > 0) updated++;
  }

  return { checked: candidates.length, updated };
}
