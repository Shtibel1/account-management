/**
 * Creating and editing clients (QA round 8). The browser used to insert into `clients` straight
 * through PostgREST, so nothing stopped two clients with the same name in one office. Creating
 * (POST /api/clients) and renaming / changing the VAT code (PATCH /api/clients/[id]) now go through
 * these functions, which refuse a name already used by another client of the same office (compared
 * with normalizeClientName: trimmed, case-insensitive, inner whitespace collapsed).
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
}

type DbError = { code?: string; message: string } | null;

/** DB access these functions need (the routes adapt the service-role client; tests pass fakes). */
export interface ClientRecordsDb {
  /** All clients of the office (null orgId = local mock mode: every client). */
  listClients(orgId: string | null): Promise<{ data: { id: string; name: string | null }[] | null; error: DbError }>;
  insertClient(row: { name: string; vat_account: string; org_id?: string }): Promise<{ data: ClientRow | null; error: DbError }>;
  insertDefaultMappings(clientId: string): Promise<{ error: DbError }>;
  updateClient(id: string, patch: { name?: string; vat_account?: string }): Promise<{ data: ClientRow | null; error: DbError }>;
}

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

async function duplicateOf(db: ClientRecordsDb, orgId: string | null, name: string, excludeId?: string) {
  const { data, error } = await db.listClients(orgId);
  if (error) throw new Error(`Listing the office clients failed: ${error.message}`);
  return { rows: data ?? [], duplicate: findDuplicateClientName(data ?? [], name, excludeId) };
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
  const { duplicate } = await duplicateOf(db, input.orgId, name);
  if (duplicate) return { ok: false, status: 409, error: DUPLICATE_CLIENT_NAME_MESSAGE, field: 'name' };

  const { data, error } = await db.insertClient({ name, vat_account: vatAccount, ...(input.orgId ? { org_id: input.orgId } : {}) });
  if (error || !data) return dbFailure(error ?? { message: 'no row returned' }, 'יצירת הלקוח נכשלה');

  // The new client starts with the default category mappings (best effort, as before).
  const mappings = await db.insertDefaultMappings(data.id);
  if (mappings.error) console.error(`[clients] Default mappings for client ${data.id} failed:`, mappings.error.message);
  return { ok: true, client: data };
}

export async function updateClientRecord(
  db: ClientRecordsDb,
  input: { id: string; orgId: string | null; name?: unknown; vatAccount?: unknown }
): Promise<ClientWriteResult> {
  const patch: { name?: string; vat_account?: string } = {};
  if (input.vatAccount !== undefined) {
    if (input.vatAccount !== null && typeof input.vatAccount !== 'string') {
      return { ok: false, status: 400, error: 'קוד חשבון מע"מ לא תקין', field: 'vat_account' };
    }
    const vatAccount = ((input.vatAccount as string | null) ?? '').trim();
    const vatErr = vatAccountError(vatAccount);
    if (vatErr) return { ok: false, status: 400, error: vatErr, field: 'vat_account' };
    patch.vat_account = vatAccount;
  }

  if (input.name !== undefined) {
    const nameErr = clientNameError(input.name);
    if (nameErr) return { ok: false, status: 400, error: nameErr, field: 'name' };
    const name = cleanClientName(input.name);
    const { rows, duplicate } = await duplicateOf(db, input.orgId, name, input.id);
    const current = rows.find((r) => r.id === input.id);
    // Only a changed name is checked, so an existing duplicate can still get its VAT code edited.
    const changed = !current || normalizeClientName(current.name) !== normalizeClientName(name);
    if (changed && duplicate) return { ok: false, status: 409, error: DUPLICATE_CLIENT_NAME_MESSAGE, field: 'name' };
    patch.name = name;
  }

  if (Object.keys(patch).length === 0) return { ok: false, status: 400, error: 'לא נשלחו שינויים' };
  const { data, error } = await db.updateClient(input.id, patch);
  if (error) return dbFailure(error, 'עדכון הלקוח נכשל');
  if (!data) return { ok: false, status: 500, error: 'עדכון הלקוח נכשל' };
  return { ok: true, client: data };
}
