import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { bankImportErrorMessage, BankImportSchema } from '@/shared/schemas';
import { BankTableMissingError, importBankRows, runAutoMatch, type ImportResult, type MatchRunResult } from '@/lib/bankTransactions';
import { requireClientAccess } from '@/lib/auth';
import { bankMatchSkippedNote } from '@/shared/bankMatch';

// Stores normalized statement rows (parsed + column-mapped in the browser) and auto-matches them.
// The import is all or nothing: a bad row is a 400 naming the row, and nothing is stored.
// Amplify cuts a request at ~28 s. A large import that already used most of that leaves the
// auto-match for later (the lines are stored; the bank page runs matching on demand), and a match
// that is started must return by AUTO_MATCH_DEADLINE_MS after the request began, so the response
// (lines committed) always arrives well before the cut.
const AUTO_MATCH_TIME_BUDGET_MS = 15_000;
const AUTO_MATCH_DEADLINE_MS = 20_000;
const MATCH_LATER = 'אפשר להשלים אותה בכפתור "הרץ התאמה אוטומטית" במסך הבנק.';

export async function POST(request: Request) {
  const startedAt = Date.now();
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'גוף הבקשה אינו JSON תקין' }, { status: 400 });
  }

  const parsed = BankImportSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: bankImportErrorMessage(parsed.error), details: parsed.error.issues.slice(0, 5) },
      { status: 400 }
    );
  }
  const { clientId, accountLabel, fileName, rows } = parsed.data;

  const access = await requireClientAccess(clientId);
  if (!access.ok) return access.response;

  let imported: ImportResult;
  try {
    imported = await importBankRows(supabase, {
      clientId,
      accountLabel,
      sourceFile: fileName ?? null,
      rows,
    });
  } catch (err) {
    console.error('[bank] Import failed:', err);
    if (err instanceof BankTableMissingError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    return NextResponse.json({ error: 'ייבוא התנועות נכשל ולא נשמרו תנועות. נסו שוב.' }, { status: 500 });
  }

  // The lines are stored; a failed / partial auto-match must not report the import itself as failed.
  let match: MatchRunResult = { matched: 0, ambiguous: 0, complete: false };
  let matchError: string | undefined;
  let matchNote: string | undefined;
  if (Date.now() - startedAt > AUTO_MATCH_TIME_BUDGET_MS) {
    console.warn(`[bank] Import of ${rows.length} rows took ${Date.now() - startedAt} ms - skipping auto-match`);
    matchNote = `התנועות נשמרו. בגלל גודל הקובץ ההתאמה האוטומטית לא הורצה - ${MATCH_LATER}`;
  } else {
    try {
      match = await runAutoMatch(supabase, clientId, {
        deadline: startedAt + AUTO_MATCH_DEADLINE_MS,
        preferBatchId: imported.batchId,
      });
      const notes: string[] = [];
      if (!match.complete) {
        console.warn(`[bank] Auto-match after import of ${rows.length} rows stopped at the deadline (${match.matched} matched)`);
        notes.push(`ההתאמה האוטומטית הושלמה חלקית (${match.matched} הותאמו) - ${MATCH_LATER}`);
      }
      if (match.truncated) {
        // The rest was matched; only these invoices were left out (another run leaves out the same ones)
        console.warn(`[bank] Auto-match after import of ${rows.length} rows left out ${match.skippedInvoices ?? '?'} invoice(s): too many candidate lines`);
        notes.push(bankMatchSkippedNote(match.skippedInvoices));
      }
      if (notes.length > 0) matchNote = `התנועות נשמרו. ${notes.join(' ')}`;
    } catch (err) {
      console.error('[bank] Auto-match after import failed:', err);
      matchError = `התנועות נשמרו, אך ההתאמה האוטומטית נכשלה. ${MATCH_LATER}`;
    }
  }

  return NextResponse.json({
    ...imported,
    matched: match.matched,
    ambiguous: match.ambiguous,
    matchComplete: match.complete,
    ...(matchError ? { matchError } : {}),
    ...(matchNote ? { matchNote } : {}),
  });
}
