import type { InvoiceExportRecord } from '@/integrations/types';
import { isExportableStatus } from '@/integrations/mapping';

/**
 * Idempotency decision for exporting one invoice to one plugin (pure, unit-tested).
 *
 *   no record / skipped          -> export (after findExisting when the plugin has it)
 *   success                      -> skip "already_exported" (force does NOT override: a document
 *                                   already exists in the target; delete it there first)
 *   success, FILE plugin,        -> "redownload": the invoice goes into the file again without a new
 *     force or dry run              claim / record (a file has no target system where a duplicate
 *                                   could be created; the user lost the download - QA N9)
 *   pending, recent              -> skip "in_progress" (another run is sending it right now)
 *   pending, stale               -> the earlier run died mid-request, it may or may not have been
 *                                   created: findExisting when available, else "blocked" unless
 *                                   force (the user checked the target system by hand)
 *   failed, certain              -> retry (after findExisting when available)
 *   failed, uncertain            -> same as a stale pending row: the failed attempt timed out / lost
 *                                   the connection / got a 5xx on a write, so the document may exist
 *                                   in the target: findExisting, else "blocked" unless force
 *   invoice not approved         -> skip "not_approved"
 */

/** A pending row older than this is considered abandoned. */
export const PENDING_STALE_MS = 10 * 60 * 1000;

export type ExportDecision =
  | { action: 'skip'; reason: 'already_exported'; externalId: string | null; url: string | null }
  | { action: 'skip'; reason: 'in_progress' }
  | { action: 'skip'; reason: 'not_approved' }
  | { action: 'blocked'; reason: 'uncertain_previous_attempt' }
  | { action: 'redownload'; externalId: string | null }
  | { action: 'check_existing' }
  | { action: 'export' };

export interface DecideExportInput {
  invoiceStatus: string;
  record: Pick<InvoiceExportRecord, 'status' | 'external_id' | 'external_url' | 'updated_at' | 'outcome_uncertain'> | null;
  hasFindExisting: boolean;
  force?: boolean;
  /** 'file' plugins (movein, excel) may rebuild the file of an exported invoice (force / dry run). */
  pluginKind?: 'api' | 'file';
  dryRun?: boolean;
  now?: number;
  pendingStaleMs?: number;
}

export function decideExport(input: DecideExportInput): ExportDecision {
  const { record, hasFindExisting } = input;
  const now = input.now ?? Date.now();
  const staleMs = input.pendingStaleMs ?? PENDING_STALE_MS;

  if (record?.status === 'success') {
    if (input.pluginKind === 'file' && (input.force || input.dryRun) && isExportableStatus(input.invoiceStatus)) {
      return { action: 'redownload', externalId: record.external_id };
    }
    return { action: 'skip', reason: 'already_exported', externalId: record.external_id, url: record.external_url };
  }
  if (!isExportableStatus(input.invoiceStatus)) return { action: 'skip', reason: 'not_approved' };

  if (record?.status === 'pending') {
    const updated = Date.parse(record.updated_at);
    const age = Number.isNaN(updated) ? Infinity : now - updated;
    if (age < staleMs) return { action: 'skip', reason: 'in_progress' };
    if (hasFindExisting) return { action: 'check_existing' };
    return input.force ? { action: 'export' } : { action: 'blocked', reason: 'uncertain_previous_attempt' };
  }

  if (record?.status === 'failed' && record.outcome_uncertain === true) {
    if (hasFindExisting) return { action: 'check_existing' };
    return input.force ? { action: 'export' } : { action: 'blocked', reason: 'uncertain_previous_attempt' };
  }
  if (record?.status === 'failed' && hasFindExisting) return { action: 'check_existing' };
  if (!record && hasFindExisting) return { action: 'check_existing' };
  return { action: 'export' };
}

/** After findExisting: adopt the found document instead of creating a second one. */
export function decideAfterLookup(found: { externalId: string; url?: string } | null):
  { action: 'adopt'; externalId: string; url: string | null } | { action: 'export' } {
  return found ? { action: 'adopt', externalId: found.externalId, url: found.url ?? null } : { action: 'export' };
}

export const DECISION_MESSAGES: Record<string, string> = {
  already_exported: 'כבר יוצאה למערכת זו',
  already_exported_file: 'כבר יוצאה לקובץ זה. להורדה חוזרת של הקובץ סמנו "ייצוא חוזר / הורדה חוזרת של הקובץ" (או הריצו הדמיה).',
  redownload: 'כבר יוצאה בעבר - נכללה שוב בקובץ להורדה חוזרת (לא נרשם ייצוא חדש). אל תקלטו את אותה חשבונית פעמיים.',
  in_progress: 'ייצוא של החשבונית כבר מתבצע',
  not_approved: 'החשבונית אינה מאושרת',
  uncertain_previous_attempt: 'ניסיון ייצוא קודם לא הסתיים בוודאות וייתכן שהמסמך כבר נוצר. בדקו במערכת היעד ונסו שוב עם "ייצוא חוזר בכל זאת".',
};
