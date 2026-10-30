'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import { AlertTriangle, Download, FileSpreadsheet, Loader2, RefreshCw, Sparkles, Upload } from 'lucide-react';
import { createClient } from '@/utils/supabase/client';
import type { BankTransaction, Client, MatchableInvoice } from '@/shared/types';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { StatementImport } from '@/components/Bank/StatementImport';
import { BankRowAction, TransactionsTable } from '@/components/Bank/TransactionsTable';
import { MatchPicker } from '@/components/Bank/MatchPicker';
import { formatAmount } from '@/components/Bank/format';
import { bankTransactionAction, BankOverviewResponse, fetchBankOverview, runBankAutoMatch } from '@/lib/api';
import { downloadMissingInvoicesXlsx, missingInvoiceTransactions } from '@/lib/exporters/missingInvoices';
import { usedInvoiceIds } from '@/shared/bankMatch';

const EMPTY: BankOverviewResponse = { transactions: [], invoices: [], candidates: {} };

export default function BankPage() {
  const supabase = createClient();
  const { toast } = useToast();
  const [clients, setClients] = useState<Client[]>([]);
  const [clientId, setClientId] = useState('');
  const [overview, setOverview] = useState<BankOverviewResponse>(EMPTY);
  const [loading, setLoading] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [tab, setTab] = useState<'all' | 'missing'>('all');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [matching, setMatching] = useState(false);
  const [pickerFor, setPickerFor] = useState<BankTransaction | null>(null);

  useEffect(() => {
    supabase.from('clients').select('*').order('name').then(({ data }) => {
      setClients((data as Client[]) ?? []);
      if (data?.length) setClientId(data[0].id);
    });
  }, []);

  const load = useCallback(async (id: string) => {
    if (!id) return;
    setLoading(true);
    try {
      setOverview(await fetchBankOverview(id));
    } catch (err) {
      console.error('[bank] Failed to load overview:', err);
      toast(err instanceof Error ? err.message : 'שגיאה בטעינת התנועות', 'error');
      setOverview(EMPTY);
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    setShowImport(false);
    load(clientId);
  }, [clientId, load]);

  const invoicesById = useMemo(
    () => new Map<string, MatchableInvoice>(overview.invoices.map((i) => [i.id, i])),
    [overview.invoices]
  );

  // Invoices free for a manual match: approved/exported and not used by any other line.
  const availableInvoices = useMemo(() => {
    const used = usedInvoiceIds(overview.transactions);
    return overview.invoices.filter((i) => !used.has(i.id) && (i.status === 'approved' || i.status === 'exported'));
  }, [overview]);

  const stats = useMemo(() => {
    const t = overview.transactions;
    const missing = missingInvoiceTransactions(t);
    const debits = t.filter((x) => x.amount < 0 && x.match_status !== 'ignored');
    const matched = debits.filter((x) => x.match_status === 'auto' || x.match_status === 'manual');
    return {
      total: t.length,
      debits: debits.length,
      matched: matched.length,
      missing: missing.length,
      missingSum: missing.reduce((s, x) => s + Math.abs(x.amount), 0),
      ignored: t.filter((x) => x.match_status === 'ignored').length,
      accountLabels: [...new Set(t.map((x) => x.account_label).filter(Boolean))].sort(),
      coverage: debits.length ? Math.round((matched.length / debits.length) * 100) : null,
    };
  }, [overview.transactions]);

  const clientName = clients.find((c) => c.id === clientId)?.name ?? '';

  const runAction = async (txn: BankTransaction, action: Exclude<BankRowAction, 'match'> | { invoiceId: string }) => {
    setBusyId(txn.id);
    try {
      const body = typeof action === 'string' ? { action } : { action: 'match' as const, invoiceId: action.invoiceId };
      await bankTransactionAction(txn.id, body);
      await load(clientId);
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
      await load(clientId);
    } catch (err) {
      console.error('[bank] Auto-match failed:', err);
      toast(err instanceof Error ? err.message : 'ההתאמה נכשלה', 'error');
    } finally {
      setMatching(false);
    }
  };

  const handleExportMissing = async () => {
    try {
      await downloadMissingInvoicesXlsx(overview.transactions, clientName);
    } catch (err) {
      console.error('[bank] Missing invoices export failed:', err);
      toast('שגיאה ביצירת קובץ האקסל', 'error');
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
        <div className="flex items-center gap-2">
          <select className="input-base w-56" value={clientId} onChange={(e) => setClientId(e.target.value)}>
            {clients.length === 0 && <option value="">אין לקוחות</option>}
            {clients.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <button
            onClick={() => load(clientId)}
            disabled={loading || !clientId}
            className="flex items-center gap-2 text-sm text-slate-500 hover:text-slate-700 transition-colors px-3 py-2 rounded-lg hover:bg-slate-100"
          >
            <RefreshCw className={clsx('h-4 w-4', loading && 'animate-spin')} />
            רענן
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

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
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
            load(clientId);
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
          <Button variant="secondary" onClick={handleExportMissing} disabled={stats.missing === 0}>
            <Download className="h-4 w-4" />
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
            onClick={() => setTab(key)}
            className={clsx(
              'px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors',
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
          available={availableInvoices}
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
    <div className="card px-5 py-4">
      <p className="text-xs font-semibold text-slate-500">{label}</p>
      <p
        dir="ltr"
        className={clsx(
          'text-2xl font-bold mt-1 text-right tabular-nums',
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
