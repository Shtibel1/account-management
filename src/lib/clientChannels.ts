import { supabase } from '@/lib/supabase';
import { generateInboundAlias, isValidInboundAlias, normalizePhone } from '@/lib/ingestHelpers';
import type { Client, ClientContact } from '@/shared/types';

/**
 * Data access for ingestion channels: client inbound email aliases (clients.inbound_alias) and
 * WhatsApp contact phones (client_contacts). Degrades gracefully when the ingestion_channels
 * migration hasn't been applied (lookups return null / empty, writes return an error message).
 */

/** Env-driven channel settings exposed to the UI (no secrets - only whether they're set). */
export function channelSettings() {
  return {
    emailDomain: process.env.INBOUND_EMAIL_DOMAIN?.trim() || null,
    emailEnabled: !!process.env.INGEST_EMAIL_SECRET,
    whatsappEnabled: !!process.env.TWILIO_AUTH_TOKEN && !!process.env.TWILIO_ACCOUNT_SID,
    whatsappNumber: process.env.TWILIO_WHATSAPP_NUMBER?.trim() || null,
  };
}

export async function findClientByAlias(aliases: string[]): Promise<Pick<Client, 'id' | 'name'> | null> {
  for (const alias of aliases) {
    const { data, error } = await supabase.from('clients').select('id, name').eq('inbound_alias', alias);
    if (error) {
      console.error('[Channels] Alias lookup failed (is the ingestion_channels migration applied?):', error.message);
      return null;
    }
    if (Array.isArray(data) && data.length > 0) return data[0] as Pick<Client, 'id' | 'name'>;
  }
  return null;
}

export async function findClientByPhone(rawPhone: string): Promise<{ clientId: string; contactName: string | null } | null> {
  const phone = normalizePhone(rawPhone);
  if (!phone) return null;
  const { data, error } = await supabase.from('client_contacts').select('client_id, name').eq('phone', phone);
  if (error) {
    console.error('[Channels] Contact lookup failed (is the ingestion_channels migration applied?):', error.message);
    return null;
  }
  if (!Array.isArray(data) || data.length === 0) return null;
  const row = data[0] as { client_id: string; name: string | null };
  return { clientId: row.client_id, contactName: row.name };
}

/**
 * Returns the client's alias, generating one when it's missing (mock DB, or rows created before
 * the column default existed). Returns null when the column doesn't exist.
 */
async function ensureAlias(client: Record<string, unknown>): Promise<string | null> {
  const current = client.inbound_alias;
  if (typeof current === 'string' && isValidInboundAlias(current)) return current;

  for (let attempt = 0; attempt < 3; attempt++) {
    const alias = generateInboundAlias();
    const { error } = await supabase.from('clients').update({ inbound_alias: alias }).eq('id', client.id as string);
    if (!error) return alias;
    if (error.code !== '23505') {
      // Not a uniqueness clash - most likely the column is missing.
      console.error(`[Channels] Could not set inbound alias for client ${String(client.id)}:`, error.message);
      return null;
    }
  }
  console.error(`[Channels] Could not generate a unique inbound alias for client ${String(client.id)}`);
  return null;
}

export interface ClientChannels {
  clientId: string;
  inboundAlias: string | null;
  contacts: ClientContact[];
}

/** Aliases + WhatsApp contacts for every client (used by the clients page). */
export async function listClientChannels(): Promise<ClientChannels[]> {
  const { data: clients, error } = await supabase.from('clients').select('*');
  if (error) throw new Error(`Failed to load clients: ${error.message}`);

  const { data: contacts, error: contactsErr } = await supabase
    .from('client_contacts')
    .select('*')
    .order('created_at', { ascending: true });
  if (contactsErr) {
    console.warn('[Channels] client_contacts unavailable (migration not applied?):', contactsErr.message);
  }
  const contactList = (contactsErr ? [] : (contacts ?? [])) as ClientContact[];

  const result: ClientChannels[] = [];
  for (const client of (clients ?? []) as Record<string, unknown>[]) {
    const clientId = client.id as string;
    result.push({
      clientId,
      inboundAlias: await ensureAlias(client),
      contacts: contactList.filter((c) => c.client_id === clientId),
    });
  }
  return result;
}

export type AddContactResult =
  | { ok: true; contact: ClientContact }
  | { ok: false; status: number; error: string };

export async function addClientContact(clientId: string, rawPhone: string, name: string | null): Promise<AddContactResult> {
  const phone = normalizePhone(rawPhone);
  if (!phone) return { ok: false, status: 400, error: 'מספר טלפון לא תקין' };

  const { data: clientRows, error: clientErr } = await supabase.from('clients').select('id').eq('id', clientId);
  if (clientErr) return { ok: false, status: 500, error: clientErr.message };
  if (!Array.isArray(clientRows) || clientRows.length === 0) return { ok: false, status: 404, error: 'לקוח לא נמצא' };

  const { data: existing, error: existingErr } = await supabase.from('client_contacts').select('id, client_id').eq('phone', phone);
  if (existingErr) {
    return { ok: false, status: 500, error: `client_contacts unavailable: ${existingErr.message}` };
  }
  if (Array.isArray(existing) && existing.length > 0) {
    const sameClient = (existing[0] as { client_id: string }).client_id === clientId;
    return { ok: false, status: 409, error: sameClient ? 'המספר כבר רשום ללקוח זה' : 'המספר כבר משויך ללקוח אחר' };
  }

  const { data, error } = await supabase
    .from('client_contacts')
    .insert({ client_id: clientId, phone, name: name?.trim() || null })
    .select()
    .single();
  if (error || !data) {
    if (error?.code === '23505') return { ok: false, status: 409, error: 'המספר כבר משויך ללקוח אחר' };
    return { ok: false, status: 500, error: error?.message ?? 'Insert failed' };
  }
  return { ok: true, contact: data as ClientContact };
}

export async function removeClientContact(clientId: string, contactId: string): Promise<{ ok: boolean; error?: string }> {
  const { error } = await supabase.from('client_contacts').delete().eq('id', contactId).eq('client_id', clientId);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
