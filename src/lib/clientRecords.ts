/**
 * Creating and editing clients (QA round 8). The browser used to insert into `clients` straight
 * through PostgREST, so nothing stopped two clients with the same name in one office. Creating
 * (POST /api/clients) and renaming / changing the VAT code (PATCH /api/clients/[id]) now go through
 * these functions, which refuse a name already used by another client of the same office (compared
 * with normalizeClientName: trimmed, case-insensitive, inner whitespace collapsed).
 *
 * Archived clients (clients.archived_at, migration 20261031133000) don't count: a new client may
 * reuse an archived client's name, and restoring one whose name is now taken is refused.
 *
 * No unique index backs this up: the live DB already holds duplicate names (QA offices and an older
 * QA run in a real office), which such an index would reject. Existing duplicates may keep their
 * names (editing only the VAT code of one of them works); only a new or changed name is checked.
 */
import { clientNameError, cleanClientName, DUPLICATE_CLIENT_NAME_MESSAGE, findDuplicateClientName, normalizeClientName } from '@/shared/clientName';
import { mappingDbErrorMessage, vatAccountError } from '@/shared/mappingValidation';

export const DEFAULT_CATEGORY_MAPPINGS: { key: string; account_code: string }[] = [
  { key: 'ציוד משרדי', account_code: '4001' },
  { key: 'שכ"ד', account_code: '4010' },
  { key: 'תקשורת', account_code: '4020' },
  { key: 'שיווק ופרסום', account_code: '4030' },
  { key: 'נסיעות', account_code: '4040' },
  { key: 'אחזקה', account_code: '4050' },
  { key: 'שירותים מקצועיים', account_code: '4060' },
  { key: 'חשמל ומים', account_code: '4070' },
  { key: 'אחר', account_code: '4099' },
];

export interface ClientRow {
  id: string;
  name: string;
  vat_account: string | null;
  org_id?: string | null;
  archived_at?: string | null;
}

type ListedClient = { id: string; name: string | null; archived_at?: string | null };

type DbError = { code?: string; message: string } | null;

/** DB access these functions need (the routes adapt the service-role client; tests pass fakes). */
export interface ClientRecordsDb {
  /** All clients of the office (null orgId = local mock mode: every client). */
  listClients(orgId: string | null): Promise<{ data: ListedClient[] | null; error: DbError }>;
  insertClient(row: { name: string; vat_account: string; org_id?: string }): Promise<{ data: ClientRow | null; error: DbError }>;
  insertDefaultMappings(clientId: string): Promise<{ error: DbError }>;
  updateClient(id: string, patch: ClientPatch): Promise<{ data: ClientRow | null; error: DbError }>;
}

type ClientPatch = { name?: string; vat_account?: string; archived_at?: string | null };

export type ClientWriteResult =
  | { ok: true; client: ClientRow }
  | { ok: false; status: 400 | 409 | 500; error: string; field?: 'name' | 'vat_account' };

function dbFailure(error: NonNullable<DbError>, fallback: string): ClientWriteResult {
  const vat = error.code === '23514' ? mappingDbErrorMessage(error) : null;
  if (vat) return { ok: false, status: 400, error: vat, field: 'vat_account' };
  if (error.code === '23505' && /name/i.test(error.message)) {
    return { ok: false, status: 409, error: DUPLICATE_CLIENT_NAME_MESSAGE, field: 'name' };
  }
  console.error('[clients] DB write failed:', error.message);
  return { ok: false, status: 500, error: fallback };
}

async function officeClients(db: ClientRecordsDb, orgId: string | null): Promise<ListedClient[]> {
  const { data, error } = await db.listClients(orgId);
  if (error) throw new Error(`Listing the office clients failed: ${error.message}`);
  return data ?? [];
}

/** Active (not archived) client of the office, other than excludeId, with the same name. */
function activeDuplicate(rows: ListedClient[], name: string, excludeId?: string) {
  return findDuplicateClientName(rows.filter((r) => !r.archived_at), name, excludeId);
}

export async function createClientRecord(
  db: ClientRecordsDb,
  input: { orgId: string | null; name: unknown; vatAccount: unknown }
): Promise<ClientWriteResult> {
  const nameErr = clientNameError(input.name);
  if (nameErr) return { ok: false, status: 400, error: nameErr, field: 'name' };
  if (input.vatAccount !== undefined && input.vatAccount !== null && typeof input.vatAccount !== 'string') {
    return { ok: false, status: 400, error: 'קוד חשבון מע"מ לא תקין', field: 'vat_account' };
  }
  const vatAccount = ((input.vatAccount as string | null | undefined) ?? '').trim();
  const vatErr = vatAccountError(vatAccount);
  if (vatErr) return { ok: false, status: 400, error: vatErr, field: 'vat_account' };

  const name = cleanClientName(input.name);
  if (activeDuplicate(await officeClients(db, input.orgId), name)) return { ok: false, status: 409, error: DUPLICATE_CLIENT_NAME_MESSAGE, field: 'name' };

  const { data, error } = await db.insertClient({ name, vat_account: vatAccount, ...(input.orgId ? { org_id: input.orgId } : {}) });
  if (error || !data) return dbFailure(error ?? { message: 'no row returned' }, 'יצירת הלקוח נכשלה');

  // The new client starts with the default category mappings (best effort, as before).
  const mappings = await db.insertDefaultMappings(data.id);
  if (mappings.error) console.error(`[clients] Default mappings for client ${data.id} failed:`, mappings.error.message);
  return { ok: true, client: data };
}

export async function updateClientRecord(
  db: ClientRecordsDb,
  input: { id: string; orgId: string | null; name?: unknown; vatAccount?: unknown; archived?: unknown }
): Promise<ClientWriteResult> {
  const patch: ClientPatch = {};
  if (input.vatAccount !== undefined) {
    if (input.vatAccount !== null && typeof input.vatAccount !== 'string') {
      return { ok: false, status: 400, error: 'קוד חשבון מע"מ לא תקין', field: 'vat_account' };
    }
    const vatAccount = ((input.vatAccount as string | null) ?? '').trim();
    const vatErr = vatAccountError(vatAccount);
    if (vatErr) return { ok: false, status: 400, error: vatErr, field: 'vat_account' };
    patch.vat_account = vatAccount;
  }
  if (input.archived !== undefined && typeof input.archived !== 'boolean') {
    return { ok: false, status: 400, error: 'ערך ארכיון לא תקין' };
  }
  if (input.name !== undefined) {
    const nameErr = clientNameError(input.name);
    if (nameErr) return { ok: false, status: 400, error: nameErr, field: 'name' };
    patch.name = cleanClientName(input.name);
  }

  if (patch.name !== undefined || input.archived !== undefined) {
    const rows = await officeClients(db, input.orgId);
    const current = rows.find((r) => r.id === input.id);
    const wasArchived = !!current?.archived_at;
    const willBeArchived = input.archived === undefined ? wasArchived : (input.archived as boolean);
    if (input.archived !== undefined && willBeArchived !== wasArchived) {
      patch.archived_at = willBeArchived ? new Date().toISOString() : null;
    }
    const finalName = patch.name ?? current?.name ?? '';
    // Only an active client that gets a new name, or comes back from the archive, is checked, so an
    // existing duplicate can still get its VAT code edited and archived clients never block anyone.
    const nameChanged = patch.name !== undefined && (!current || normalizeClientName(current.name) !== normalizeClientName(patch.name));
    if (!willBeArchived && (nameChanged || wasArchived) && activeDuplicate(rows, finalName, input.id)) {
      return { ok: false, status: 409, error: DUPLICATE_CLIENT_NAME_MESSAGE, field: 'name' };
    }
  }

  if (Object.keys(patch).length === 0) {
    if (input.archived !== undefined) return { ok: false, status: 400, error: input.archived ? 'הלקוח כבר בארכיון' : 'הלקוח אינו בארכיון' };
    return { ok: false, status: 400, error: 'לא נשלחו שינויים' };
  }
  const { data, error } = await db.updateClient(input.id, patch);
  if (error) return dbFailure(error, 'עדכון הלקוח נכשל');
  if (!data) return { ok: false, status: 500, error: 'עדכון הלקוח נכשל' };
  return { ok: true, client: data };
}
