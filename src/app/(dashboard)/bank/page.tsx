'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { AlertTriangle, Download, FileSpreadsheet, Loader2, RefreshCw, Sparkles, Upload } from 'lucide-react';
import { createClient } from '@/utils/supabase/client';
import type { BankTransaction, Client, MatchableInvoice } from '@/shared/types';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { useConfirm } from '@/components/ui/ConfirmDialog';
import { StatementImport } from '@/components/Bank/StatementImport';
import { BankRowAction, BankTableFilters, TransactionsTable } from '@/components/Bank/TransactionsTable';
import { MatchPicker } from '@/components/Bank/MatchPicker';
import { formatAmount } from '@/components/Bank/format';
import {
  bankTransactionAction,
  BankOverviewResponse,
  BankRequestError,
  fetchBankOverview,
  fetchMissingBankLines,
  runBankAutoMatch,
} from '@/lib/api';
import { downloadMissingInvoicesXlsx } from '@/lib/exporters/missingInvoices';
import { DEFAULT_BANK_PAGE_SIZE, summarizeBankTransactions } from '@/shared/bankOverview';
import { clientDisplayNames } from '@/shared/clientLabels';
import { bankMatchSkippedNote } from '@/shared/bankMatch';

const EMPTY: BankOverviewResponse = {
  transactions: [],
  total: 0,
  page: 1,
  pageSize: DEFAULT_BANK_PAGE_SIZE,
  totalPages: 1,
  summary: summarizeBankTransactions([]),
  invoices: [],
  available: [],
  candidates: {},
};

const DEFAULT_FILTERS: BankTableFilters = { status: 'all', account: null, search: '' };

export default function BankPage() {
  const supabase = createClient();
  const { toast } = useToast();
  const askConfirm = useConfirm();
  const [clients, setClients] = useState<Client[]>([]);
  const clientLabels = useMemo(() => clientDisplayNames(clients), [clients]);
  const [clientId, setClientId] = useState('');
  const [overview, setOverview] = useState<BankOverviewResponse>(EMPTY);
  const [loading, setLoading] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [tab, setTab] = useState<'all' | 'missing'>('all');
  const [filters, setFilters] = useState<BankTableFilters>(DEFAULT_FILTERS);
  const [page, setPage] = useState(1);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [matching, setMatching] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [pickerFor, setPickerFor] = useState<BankTransaction | null>(null);
  // Only the newest request may update the page (filters / paging can change while one is in flight).
  const requestSeq = useRef(0);

  useEffect(() => {
    supabase.from('clients').select('*').is('archived_at', null).order('name').then(({ data }) => {
      setClients((data as Client[]) ?? []);
      if (data?.length) setClientId(data[0].id);
    });
  }, []);

  // The server filters and pages the lines; the page only ever holds one page of them.
  const load = useCallback(async () => {
    if (!clientId) return;
    const seq = ++requestSeq.current;
    setLoading(true);
    try {
      const next = await fetchBankOverview(clientId, {
        mode: tab,
        status: filters.status,
        account: filters.account,
        search: filters.search,
        page,
        pageSize: DEFAULT_BANK_PAGE_SIZE,
      });
      if (seq !== requestSeq.current) return;
      setOverview(next);
      if (next.page !== page) setPage(next.page); // the list shrank under the current page
    } catch (err) {
      if (seq !== requestSeq.current) return;
      console.error('[bank] Failed to load overview:', err);
      toast(err instanceof Error ? err.message : 'שגיאה בטעינת התנועות', 'error');
      setOverview(EMPTY);
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [clientId, tab, filters, page, toast]);

  useEffect(() => {
    load();
  }, [load]);

  // New client: start over (filters of one client's accounts make no sense for another).
  useEffect(() => {
    setShowImport(false);
    setFilters(DEFAULT_FILTERS);
    setPage(1);
  }, [clientId]);

  const handleFiltersChange = useCallback((patch: Partial<BankTableFilters>) => {
    setFilters((f) => ({ ...f, ...patch }));
    setPage(1);
  }, []);

  const invoicesById = useMemo(
    () => new Map<string, MatchableInvoice>([...overview.available, ...overview.invoices].map((i) => [i.id, i])),
    [overview.available, overview.invoices]
  );

  const stats = useMemo(() => {
    const s = overview.summary;
    return { ...s, coverage: s.debits ? Math.round((s.matched / s.debits) * 100) : null };
  }, [overview.summary]);

  const clientName = clients.find((c) => c.id === clientId)?.name ?? '';

  const runAction = async (txn: BankTransaction, action: Exclude<BankRowAction, 'match'> | { invoiceId: string }) => {
    setBusyId(txn.id);
    try {
      if (typeof action === 'string') {
        await bankTransactionAction(txn.id, { action });
      } else {
        try {
          await bankTransactionAction(txn.id, { action: 'match', invoiceId: action.invoiceId });
        } catch (err) {
          // Invoice total differs from the charge: only on the reviewer's explicit confirmation.
          if (!(err instanceof BankRequestError) || err.code !== 'amount_mismatch') throw err;
          if (!(await askConfirm({ title: 'הסכום אינו תואם', message: `${err.message}.\nלהתאים בכל זאת?`, confirmLabel: 'התאם בכל זאת' }))) return;
          await bankTransactionAction(txn.id, { action: 'match', invoiceId: action.invoiceId, force: true });
        }
      }
      await load();
    } catch (err) {
      console.error('[bank] Action failed:', err);
      toast(err instanceof Error ? err.message : 'הפעולה נכשלה', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const handleRowAction = (txn: BankTransaction, action: BankRowAction) => {
    if (action === 'match') setPickerFor(txn);
    else runAction(txn, action);
  };

  const handleAutoMatch = async () => {
    setMatching(true);
    try {
      const result = await runBankAutoMatch(clientId);
      toast(
        result.matched > 0 ? `הותאמו ${result.matched} תנועות נוספות` : 'לא נמצאו התאמות חדשות',
        result.matched > 0 ? 'success' : 'info'
      );
      // Invoices with too many candidate lines were left out; another click leaves out the same ones
      if (result.truncated) toast(bankMatchSkippedNote(result.skippedInvoices), 'info');
      // The run is bounded by a deadline (large statements): another click continues it
      if (result.complete === false) toast('ההתאמה האוטומטית הושלמה חלקית בגלל מגבלת זמן - לחצו שוב להמשך', 'info');
      await load();
    } catch (err) {
      console.error('[bank] Auto-match failed:', err);
      toast(err instanceof Error ? err.message : 'ההתאמה נכשלה', 'error');
    } finally {
      setMatching(false);
    }
  };

  const handleExportMissing = async () => {
    setExporting(true);
    try {
      // Every missing line, not just the page on screen (fetched page by page, sheet columns only).
      const missing = await fetchMissingBankLines(clientId);
      await downloadMissingInvoicesXlsx(missing, clientName);
    } catch (err) {
      console.error('[bank] Missing invoices export failed:', err);
      toast(err instanceof Error ? err.message : 'שגיאה ביצירת קובץ האקסל', 'error');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-6 max-w-6xl">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-slate-900">התאמות בנק</h2>
          <p className="text-sm text-slate-500 mt-1">
            ייבוא דפי בנק ואשראי, התאמה לחשבוניות מאושרות ורשימת חשבוניות חסרות ללקוח
          </p>
        </div>
        <div className="flex items-center gap-2 w-full sm:w-auto">
          {/* Wide enough for disambiguated labels like "name (חשבון מע"מ 12345)"; full width on phones */}
          <label className="flex items-center gap-2 flex-1 min-w-0 sm:flex-none">
            <span className="text-sm font-medium text-slate-700 shrink-0">לקוח:</span>
            <select className="input-base flex-1 min-w-0 sm:flex-none sm:w-80" value={clientId} onChange={(e) => setClientId(e.target.value)}>
              {clients.length === 0 && <option value="">אין לקוחות</option>}
              {clients.map((c) => (
                <option key={c.id} value={c.id}>{clientLabels.get(c.id) ?? c.name}</option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => load()}
            disabled={loading || !clientId}
            className="shrink-0 flex items-center gap-2 text-sm text-slate-500 hover:text-slate-700 transition-colors px-3 min-h-[44px] rounded-lg hover:bg-slate-100"
          >
            <RefreshCw className={clsx('h-4 w-4', loading && 'animate-spin')} aria-hidden="true" />
            {/* Icon only on phones so the client select gets the room */}
            <span className="sr-only sm:not-sr-only">רענן</span>
          </button>
        </div>
      </div>

      {overview.setupRequired && (
        <div className="flex items-start gap-3 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <span>
            טבלת התנועות עדיין לא קיימת בבסיס הנתונים. יש להריץ את המיגרציה{' '}
            <code dir="ltr" className="font-mono text-xs">20261030136000_bank_transactions.sql</code> ב-Supabase.
          </span>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 sm:gap-4">
        <StatCard label="תנועות" value={stats.total.toLocaleString('he-IL')} hint={stats.ignored ? `${stats.ignored} הוחרגו` : undefined} />
        <StatCard label="חיובים מותאמים" value={`${stats.matched} / ${stats.debits}`} hint={stats.coverage != null ? `${stats.coverage}% כיסוי` : undefined} tone="emerald" />
        <StatCard label="חשבוניות חסרות" value={stats.missing.toLocaleString('he-IL')} tone={stats.missing ? 'amber' : 'slate'} />
        <StatCard label='סה"כ חסר' value={`₪${formatAmount(stats.missingSum)}`} tone={stats.missing ? 'amber' : 'slate'} />
      </div>

      {showImport && clientId ? (
        <StatementImport
          clientId={clientId}
          existingAccountLabels={stats.accountLabels}
          onCancel={() => setShowImport(false)}
          onImported={() => {
            setShowImport(false);
            load();
          }}
        />
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => setShowImport(true)} disabled={!clientId || overview.setupRequired}>
            <Upload className="h-4 w-4" />
            ייבוא דף חשבון
          </Button>
          <Button variant="secondary" onClick={handleAutoMatch} disabled={!clientId || matching || stats.missing === 0}>
            {matching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            הרץ התאמה אוטומטית
          </Button>
          <Button variant="secondary" onClick={handleExportMissing} disabled={stats.missing === 0 || exporting}>
            {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            ייצוא חשבוניות חסרות לאקסל
          </Button>
        </div>
      )}

      <div className="flex items-center gap-1 border-b border-slate-200">
        {([
          ['all', 'כל התנועות', stats.total],
          ['missing', 'חשבוניות חסרות', stats.missing],
        ] as const).map(([key, label, count]) => (
          <button
            key={key}
            onClick={() => {
              setTab(key);
              setPage(1);
            }}
            className={clsx(
              'px-4 py-2.5 min-h-[44px] text-sm font-medium border-b-2 -mb-px transition-colors',
              tab === key ? 'border-blue-600 text-blue-700' : 'border-transparent text-slate-500 hover:text-slate-700'
            )}
          >
            {label}
            <span className={clsx('mr-1.5 text-xs rounded-full px-2 py-0.5', tab === key ? 'bg-blue-50' : 'bg-slate-100')}>{count}</span>
          </button>
        ))}
      </div>

      {tab === 'missing' && stats.missing > 0 && (
        <p className="text-sm text-slate-500 flex items-center gap-2">
          <FileSpreadsheet className="h-4 w-4 text-emerald-600" />
          חיובים שלא נמצאה עבורם חשבונית מאושרת. ייצא לאקסל ושלח ללקוח, או החרג תנועות שאינן דורשות חשבונית.
        </p>
      )}

      {loading && overview.transactions.length === 0 ? (
        <div className="flex items-center justify-center py-24 text-slate-400">
          <Loader2 className="h-7 w-7 animate-spin" />
        </div>
      ) : (
        <TransactionsTable
          transactions={overview.transactions}
          total={overview.total}
          page={overview.page}
          pageSize={overview.pageSize}
          totalPages={overview.totalPages}
          accounts={stats.accountLabels}
          filters={filters}
          onFiltersChange={handleFiltersChange}
          onPageChange={setPage}
          invoicesById={invoicesById}
          candidates={overview.candidates}
          busyId={busyId}
          mode={tab}
          onAction={handleRowAction}
        />
      )}

      {pickerFor && (
        <MatchPicker
          transaction={pickerFor}
          available={overview.available}
          candidateIds={overview.candidates[pickerFor.id] ?? []}
          onClose={() => setPickerFor(null)}
          onSelect={(invoiceId) => {
            const txn = pickerFor;
            setPickerFor(null);
            runAction(txn, { invoiceId });
          }}
        />
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  hint,
  tone = 'slate',
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'slate' | 'emerald' | 'amber';
}) {
  return (
    <div className="card px-3 py-3 sm:px-5 sm:py-4 min-w-0">
      <p className="text-xs font-semibold text-slate-500">{label}</p>
      <p
        dir="ltr"
        className={clsx(
          'text-lg sm:text-2xl font-bold mt-1 text-right tabular-nums break-all',
          tone === 'emerald' && 'text-emerald-700',
          tone === 'amber' && 'text-amber-700',
          tone === 'slate' && 'text-slate-900'
        )}
      >
        {value}
      </p>
      {hint && <p className="text-xs text-slate-400 mt-0.5">{hint}</p>}
    </div>
  );
}
