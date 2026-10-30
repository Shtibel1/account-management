import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { bankImportErrorMessage, BankImportSchema } from '@/shared/schemas';
import { BankTableMissingError, importBankRows, runAutoMatch, type ImportResult, type MatchRunResult } from '@/lib/bankTransactions';
import { requireClientAccess } from '@/lib/auth';

// Stores normalized statement rows (parsed + column-mapped in the browser) and auto-matches them.
// The import is all or nothing: a bad row is a 400 naming the row, and nothing is stored.
export async function POST(request: Request) {
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

  // The lines are stored; a failed auto-match must not report the import itself as failed.
  let match: MatchRunResult = { matched: 0, ambiguous: 0 };
  let matchError: string | undefined;
  try {
    match = await runAutoMatch(supabase, clientId);
  } catch (err) {
    console.error('[bank] Auto-match after import failed:', err);
    matchError = 'התנועות נשמרו, אך ההתאמה האוטומטית נכשלה. אפשר להריץ אותה שוב מהמסך.';
  }

  return NextResponse.json({ ...imported, matched: match.matched, ambiguous: match.ambiguous, ...(matchError ? { matchError } : {}) });
}
