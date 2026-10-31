import { supabase } from '@/lib/supabase';
import { DEFAULT_CATEGORY_MAPPINGS, type ClientRecordsDb, type ClientRow } from '@/lib/clientRecords';

const COLUMNS = 'id, name, vat_account, org_id, inbound_alias, created_at';

/** ClientRecordsDb over the service-role client. Routes call it only after their access checks. */
export function serviceClientRecordsDb(): ClientRecordsDb {
  return {
    async listClients(orgId) {
      let query = supabase.from('clients').select('id, name');
      if (orgId) query = query.eq('org_id', orgId);
      const { data, error } = await query;
      return { data: (data ?? null) as { id: string; name: string | null }[] | null, error };
    },
    async insertClient(row) {
      const { data, error } = await supabase.from('clients').insert(row).select(COLUMNS).single();
      return { data: (data ?? null) as ClientRow | null, error };
    },
    async insertDefaultMappings(clientId) {
      const { error } = await supabase.from('account_mappings').insert(
        DEFAULT_CATEGORY_MAPPINGS.map((cat) => ({ client_id: clientId, mapping_type: 'category', key: cat.key, account_code: cat.account_code }))
      );
      return { error };
    },
    async updateClient(id, patch) {
      const { data, error } = await supabase.from('clients').update(patch).eq('id', id).select(COLUMNS).single();
      return { data: (data ?? null) as ClientRow | null, error };
    },
  };
}
