/**
 * Deleting a client (QA round 4 #1). The DB decides what may go (migration
 * 20261031101000_qa4_client_delete_guard.sql): a client is deleted only while every invoice is
 * failed ('error') or awaiting review, none was ever exported, none has status audit events and no
 * bank statement was imported for it, so approved / exported books are never wiped by the cascade. delete_client_guarded() checks and
 * deletes in one transaction; the files under raw-invoices/<client_id>/ are then removed through
 * the Storage API (SQL can't delete storage objects), together with the client's invoice files kept
 * in other folders, except files another invoice still references (an invoice moved to another
 * client keeps its file under the old folder - QA round 6). Office owners only (checked by the route);
 * browser sessions have no delete policy on clients, so this is the only way to delete one.
 */

export type ClientDeleteBlocker = 'not_found' | 'not_owner' | 'active_invoices' | 'exported' | 'audit_history' | 'bank_transactions';

export const CLIENT_DELETE_MESSAGES: Record<ClientDeleteBlocker, string> = {
  not_found: 'הלקוח לא נמצא',
  not_owner: 'רק בעלי המשרד יכולים למחוק לקוח',
  active_invoices: 'ללקוח יש חשבוניות בעיבוד, מאושרות, שיוצאו, שנדחו או שהוחזרו - לא ניתן למחוק אותו. ניתן למחוק לקוח רק כשכל החשבוניות שלו נכשלו בעיבוד או ממתינות לבדיקה',
  exported: 'חשבוניות של הלקוח כבר יוצאו להנהלת החשבונות - לא ניתן למחוק אותו',
  audit_history: 'לחשבוניות של הלקוח יש היסטוריית פעולות (פתיחה מחדש / דחייה) שנשמרת - לא ניתן למחוק אותו',
  bank_transactions: 'ללקוח יובאו תנועות בנק (דפי חשבון והתאמות) - לא ניתן למחוק אותו',
};

const BLOCKERS = new Set<string>(Object.keys(CLIENT_DELETE_MESSAGES));

export function isClientDeleteBlocker(value: unknown): value is ClientDeleteBlocker {
  return typeof value === 'string' && BLOCKERS.has(value);
}

/** The part of the Supabase client this module uses (injectable for tests). */
export interface ClientDeletionDb {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
  storage: {
    from: (bucket: string) => {
      list: (
        prefix: string,
        options: { limit: number; offset: number }
      ) => PromiseLike<{ data: { name: string; id?: string | null }[] | null; error: { message: string } | null }>;
      remove: (paths: string[]) => PromiseLike<{ error: { message: string } | null }>;
    };
  };
}

export type ClientDeleteResult =
  | { ok: true; filesRemoved: number; filesFailed: number }
  | { ok: false; blocker: ClientDeleteBlocker }
  | { ok: false; error: string };

const LIST_PAGE = 1000;
const REMOVE_CHUNK = 100;
/** More files than this are left for a later cleanup (the request must end in time). */
const MAX_FILES = 20_000;

/** Object paths under <clientId>/ in the bucket (flat: uploads, splits and parts are all <clientId>/<file>). */
export async function listClientFiles(db: ClientDeletionDb, bucket: string, clientId: string): Promise<string[]> {
  const paths: string[] = [];
  for (let offset = 0; offset < MAX_FILES; offset += LIST_PAGE) {
    const { data, error } = await db.storage.from(bucket).list(clientId, { limit: LIST_PAGE, offset });
    if (error) throw new Error(`Storage list failed: ${error.message}`);
    const page = data ?? [];
    // Entries without an id are folders (none are created under a client, so nothing to descend into)
    for (const entry of page) if (entry.name && entry.id !== null) paths.push(`${clientId}/${entry.name}`);
    if (page.length < LIST_PAGE) break;
  }
  return paths;
}

/**
 * Deletes the client when the DB rules allow it, then its stored files (best effort: the row is
 * gone either way, an orphaned file is only wasted storage, and it is logged).
 */
export async function deleteClientWithFiles(db: ClientDeletionDb, bucket: string, clientId: string): Promise<ClientDeleteResult> {
  // Read before the cascade removes the rows: files of the client's invoices outside its folder
  const own = await db.rpc('client_invoice_file_paths', { p_client_id: clientId });
  if (own.error) return { ok: false, error: own.error.message };
  const ownPaths = Array.isArray(own.data) ? (own.data as string[]) : [];

  const { data, error } = await db.rpc('delete_client_guarded', { p_client_id: clientId });
  if (error) return { ok: false, error: error.message };
  if (isClientDeleteBlocker(data)) return { ok: false, blocker: data };
  if (data !== 'deleted') return { ok: false, error: `unexpected answer: ${String(data)}` };

  let filesRemoved = 0;
  let filesFailed = 0;
  try {
    const candidates = [...new Set([...(await listClientFiles(db, bucket, clientId)), ...ownPaths])];
    const inUse = new Set<string>();
    for (let i = 0; i < candidates.length; i += LIST_PAGE) {
      const { data: used, error: usedErr } = await db.rpc('storage_paths_in_use', { p_paths: candidates.slice(i, i + LIST_PAGE) });
      if (usedErr) throw new Error(`File reference check failed: ${usedErr.message}`);
      for (const p of (used as string[] | null) ?? []) inUse.add(p);
    }
    if (inUse.size > 0) console.log(`[clients/delete] Kept ${inUse.size} files of client ${clientId} that other invoices still use.`);
    const paths = candidates.filter((p) => !inUse.has(p));
    for (let i = 0; i < paths.length; i += REMOVE_CHUNK) {
      const chunk = paths.slice(i, i + REMOVE_CHUNK);
      const { error: removeErr } = await db.storage.from(bucket).remove(chunk);
      if (removeErr) {
        filesFailed += chunk.length;
        console.error(`[clients/delete] Removing ${chunk.length} files of client ${clientId} failed:`, removeErr.message);
      } else {
        filesRemoved += chunk.length;
      }
    }
  } catch (err) {
    console.error(`[clients/delete] Listing the files of deleted client ${clientId} failed:`, err instanceof Error ? err.message : err);
    filesFailed += 1;
  }
  return { ok: true, filesRemoved, filesFailed };
}
