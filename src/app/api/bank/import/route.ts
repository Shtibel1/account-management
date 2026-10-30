import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { BankImportSchema } from '@/shared/schemas';
import { BankTableMissingError, importBankRows, runAutoMatch } from '@/lib/bankTransactions';

// Stores normalized statement rows (parsed + column-mapped in the browser) and auto-matches them.
export async function POST(request: Request) {
  try {
    const parsed = BankImportSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'נתוני הייבוא אינם תקינים', details: parsed.error.issues.slice(0, 5) },
        { status: 400 }
      );
    }
    const { clientId, accountLabel, fileName, rows } = parsed.data;

    const imported = await importBankRows(supabase, {
      clientId,
      accountLabel,
      sourceFile: fileName ?? null,
      rows,
    });
    const match = await runAutoMatch(supabase, clientId);

    return NextResponse.json({ ...imported, matched: match.matched, ambiguous: match.ambiguous });
  } catch (err) {
    console.error('[bank] Import failed:', err);
    const status = err instanceof BankTableMissingError ? 503 : 500;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status }
    );
  }
}
