import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { BankTableMissingError, loadBankOverview, type BankOverview } from '@/lib/bankTransactions';
import { requireClientAccess } from '@/lib/auth';
import { parseBankListQuery, summarizeBankTransactions } from '@/shared/bankOverview';

// One page of a client's statement lines (filters: mode, status, account, q; paging: page,
// pageSize) + summary counts over all lines + the invoices / candidates that page needs.
// view=lines returns only the lines (paged export of the missing-invoices list).
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const clientId = params.get('clientId');
  if (!clientId) {
    return NextResponse.json({ error: 'חסר לקוח' }, { status: 400 });
  }

  const access = await requireClientAccess(clientId);
  if (!access.ok) return access.response;

  const query = parseBankListQuery(params);
  try {
    const overview = await loadBankOverview(supabase, clientId, query, { linesOnly: params.get('view') === 'lines' });
    return NextResponse.json(overview);
  } catch (err) {
    if (err instanceof BankTableMissingError) {
      // Migration not applied yet: render an empty page with a notice instead of failing.
      console.error('[bank] GET:', err.message);
      const empty: BankOverview & { setupRequired: true } = {
        transactions: [],
        total: 0,
        page: 1,
        pageSize: query.pageSize,
        totalPages: 1,
        summary: summarizeBankTransactions([]),
        invoices: [],
        available: [],
        candidates: {},
        setupRequired: true,
      };
      return NextResponse.json(empty);
    }
    console.error('[bank] GET failed:', err);
    return NextResponse.json({ error: 'שגיאה בטעינת תנועות הבנק' }, { status: 500 });
  }
}
