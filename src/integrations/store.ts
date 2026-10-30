import type { SupabaseClient } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import type {
  ClientIntegrationView,
  IntegrationEnvironment,
  IntegrationLogRow,
  IntegrationLogSink,
  InvoiceExportRecord,
} from '@/integrations/types';

/**
 * SERVER-ONLY persistence for integrations (service-role client: callers must have run the route
 * guards first). Kept behind small interfaces so the export runner can be exercised with fakes.
 */

export interface StoredIntegration extends ClientIntegrationView {
  config_encrypted: string | null;
}

const VIEW_COLUMNS = 'id, client_id, plugin_id, enabled, environment, config_masked, created_at, updated_at';

export async function listClientIntegrations(clientId: string, db: SupabaseClient = supabase): Promise<ClientIntegrationView[]> {
  const { data, error } = await db
    .from('client_integrations')
    .select(VIEW_COLUMNS)
    .eq('client_id', clientId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`Failed to load integrations: ${error.message}`);
  return (data ?? []) as ClientIntegrationView[];
}

export async function getStoredIntegration(
  clientId: string,
  pluginId: string,
  db: SupabaseClient = supabase
): Promise<StoredIntegration | null> {
  const { data, error } = await db
    .from('client_integrations')
    .select(`${VIEW_COLUMNS}, config_encrypted`)
    .eq('client_id', clientId)
    .eq('plugin_id', pluginId)
    .maybeSingle();
  if (error) throw new Error(`Failed to load integration: ${error.message}`);
  return (data as StoredIntegration | null) ?? null;
}

export interface IntegrationWrite {
  enabled: boolean;
  environment: IntegrationEnvironment;
  config_encrypted: string | null;
  config_masked: Record<string, unknown>;
}

export async function upsertIntegration(
  clientId: string,
  pluginId: string,
  values: IntegrationWrite,
  db: SupabaseClient = supabase
): Promise<ClientIntegrationView> {
  const existing = await getStoredIntegration(clientId, pluginId, db);
  const query = existing
    ? db.from('client_integrations').update({ ...values, updated_at: new Date().toISOString() }).eq('id', existing.id)
    : db.from('client_integrations').insert({ client_id: clientId, plugin_id: pluginId, ...values });
  const { data, error } = await query.select(VIEW_COLUMNS).single();
  if (error || !data) throw new Error(`Failed to save integration: ${error?.message ?? 'no row'}`);
  return data as ClientIntegrationView;
}

export async function deleteIntegration(clientId: string, pluginId: string, db: SupabaseClient = supabase): Promise<void> {
  const { error } = await db.from('client_integrations').delete().eq('client_id', clientId).eq('plugin_id', pluginId);
  if (error) throw new Error(`Failed to delete integration: ${error.message}`);
}

// ── integration_logs ──────────────────────────────────────────────────────

export function supabaseLogSink(db: SupabaseClient = supabase): IntegrationLogSink {
  return {
    async write(row: IntegrationLogRow) {
      const { error } = await db.from('integration_logs').insert(row);
      if (error) throw new Error(error.message);
    },
  };
}

// ── invoice_exports ───────────────────────────────────────────────────────

export interface ExportStore {
  getRecords(invoiceIds: string[], pluginId: string): Promise<InvoiceExportRecord[]>;
  /**
   * Atomically marks the invoice as being exported (status pending, attempts + 1). Returns null when
   * another run changed / claimed the row in the meantime (optimistic concurrency).
   */
  claim(params: {
    invoiceId: string;
    clientId: string;
    pluginId: string;
    correlationId: string;
    previous: InvoiceExportRecord | null;
  }): Promise<InvoiceExportRecord | null>;
  complete(recordId: string, patch: {
    status: 'success' | 'failed';
    external_id?: string | null;
    external_url?: string | null;
    last_error?: string | null;
    /** Failed, but the document may have been created anyway (see idempotency.ts). */
    uncertain?: boolean;
  }): Promise<void>;
  /** Records "skipped" (e.g. not approved) unless a row already exists. */
  recordSkipped(params: { invoiceId: string; clientId: string; pluginId: string; correlationId: string; reason: string }): Promise<void>;
  /** Sets invoices.status = 'exported' (+ exported_at) for invoices that are still 'approved'. */
  markInvoicesExported(invoiceIds: string[]): Promise<void>;
}

const UNIQUE_VIOLATION = '23505';

export function supabaseExportStore(db: SupabaseClient = supabase): ExportStore {
  return {
    async getRecords(invoiceIds, pluginId) {
      if (invoiceIds.length === 0) return [];
      const { data, error } = await db
        .from('invoice_exports')
        .select('*')
        .in('invoice_id', invoiceIds)
        .eq('plugin_id', pluginId);
      if (error) throw new Error(`Failed to load export records: ${error.message}`);
      return (data ?? []) as InvoiceExportRecord[];
    },

    async claim({ invoiceId, clientId, pluginId, correlationId, previous }) {
      if (!previous) {
        const { data, error } = await db
          .from('invoice_exports')
          .insert({
            invoice_id: invoiceId, client_id: clientId, plugin_id: pluginId,
            status: 'pending', attempts: 1, correlation_id: correlationId,
          })
          .select('*')
          .single();
        if (error) {
          if (error.code === UNIQUE_VIOLATION) return null;
          throw new Error(`Failed to claim export: ${error.message}`);
        }
        return data as InvoiceExportRecord;
      }
      const { data, error } = await db
        .from('invoice_exports')
        .update({
          status: 'pending',
          attempts: previous.attempts + 1,
          correlation_id: correlationId,
          last_error: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', previous.id)
        .eq('status', previous.status)
        .eq('attempts', previous.attempts)
        .select('*');
      if (error) throw new Error(`Failed to claim export: ${error.message}`);
      const rows = (data ?? []) as InvoiceExportRecord[];
      return rows[0] ?? null;
    },

    async complete(recordId, patch) {
      const now = new Date().toISOString();
      const { error } = await db
        .from('invoice_exports')
        .update({
          status: patch.status,
          external_id: patch.external_id ?? null,
          external_url: patch.external_url ?? null,
          last_error: patch.last_error ? patch.last_error.slice(0, 2000) : null,
          outcome_uncertain: patch.status === 'failed' && patch.uncertain === true,
          exported_at: patch.status === 'success' ? now : null,
          updated_at: now,
        })
        .eq('id', recordId);
      if (error) throw new Error(`Failed to record export result: ${error.message}`);
    },

    async recordSkipped({ invoiceId, clientId, pluginId, correlationId, reason }) {
      const { error } = await db.from('invoice_exports').insert({
        invoice_id: invoiceId, client_id: clientId, plugin_id: pluginId,
        status: 'skipped', attempts: 0, correlation_id: correlationId, last_error: reason,
      });
      if (error && error.code !== UNIQUE_VIOLATION) throw new Error(`Failed to record skipped export: ${error.message}`);
    },

    async markInvoicesExported(invoiceIds) {
      if (invoiceIds.length === 0) return;
      const now = new Date().toISOString();
      const { error } = await db
        .from('invoices')
        .update({ status: 'exported', exported_at: now, updated_at: now })
        .in('id', invoiceIds)
        .eq('status', 'approved');
      if (error) throw new Error(`Failed to mark invoices exported: ${error.message}`);
    },
  };
}
