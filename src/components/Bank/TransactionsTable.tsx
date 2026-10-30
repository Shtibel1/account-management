'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import clsx from 'clsx';
import { ChevronLeft, ChevronRight, EyeOff, Link2, Loader2, RotateCcw, Search, Unlink } from 'lucide-react';
import type { BankMatchStatus, BankTransaction, MatchableInvoice } from '@/shared/types';
import type { BankStatusFilter } from '@/shared/bankOverview';
import { formatIsoDateHe } from '@/lib/exporters/missingInvoices';
import { formatAmount } from '@/components/Bank/format';

export type BankRowAction = 'match' | 'unmatch' | 'ignore' | 'restore';

export interface BankTableFilters {
  status: BankStatusFilter;
  /** null = every account. */
  account: string | null;
  search: string;
}

interface Props {
  /** The current page of lines, already filtered and paged by the server (GET /api/bank). */
  transactions: BankTransaction[];
  /** Lines matching the filters, across all pages. */
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  /** Every account label of the client (from the server summary). */
  accounts: string[];
  filters: BankTableFilters;
  onFiltersChange: (patch: Partial<BankTableFilters>) => void;
  onPageChange: (page: number) => void;
  invoicesById: Map<string, MatchableInvoice>;
  candidates: Record<string, string[]>;
  busyId: string | null;
  /** 'missing' = unmatched debits only, without the status filter. */
  mode: 'all' | 'missing';
  onAction: (transaction: BankTransaction, action: BankRowAction) => void;
}

const SEARCH_DEBOUNCE_MS = 300;

const STATUS_CONFIG: Record<BankMatchStatus, { label: string; className: string; dot: string }> = {
  auto:      { label: 'הותאם אוטומטית', className: 'bg-emerald-50 text-emerald-700 border-emerald-200', dot: 'bg-emerald-500' },
  manual:    { label: 'הותאם ידנית',    className: 'bg-blue-50 text-blue-700 border-blue-200',          dot: 'bg-blue-500' },
  unmatched: { label: 'ללא חשבונית',    className: 'bg-amber-50 text-amber-700 border-amber-200',       dot: 'bg-amber-400' },
  ignored:   { label: 'הוחרג',          className: 'bg-slate-100 text-slate-500 border-slate-200',      dot: 'bg-slate-400' },
};

function BankStatusBadge({ transaction }: { transaction: BankTransaction }) {
  // Unmatched credits (refunds, income) don't need an invoice - don't flag them as missing.
  const cfg =
    transaction.match_status === 'unmatched' && transaction.amount > 0
      ? { label: 'זיכוי', className: 'bg-slate-50 text-slate-500 border-slate-200', dot: 'bg-slate-300' }
      : STATUS_CONFIG[transaction.match_status];
  return (
    <span className={clsx('inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border whitespace-nowrap', cfg.className)}>
      <span className={clsx('w-1.5 h-1.5 rounded-full shrink-0', cfg.dot)} />
      {cfg.label}
    </span>
  );
}

function getPageNumbers(currentPage: number, totalPages: number) {
  const pages: (number | string)[] = [];
  if (totalPages <= 5) {
    for (let i = 1; i <= totalPages; i++) pages.push(i);
  } else if (currentPage <= 3) {
    pages.push(1, 2, 3, 4, '...', totalPages);
  } else if (currentPage >= totalPages - 2) {
    pages.push(1, '...', totalPages - 3, totalPages - 2, totalPages - 1, totalPages);
  } else {
    pages.push(1, '...', currentPage - 1, currentPage, currentPage + 1, '...', totalPages);
  }
  return pages;
}

export function TransactionsTable({
  transactions,
  total,
  page,
  pageSize,
  totalPages,
  accounts,
  filters,
  onFiltersChange,
  onPageChange,
  invoicesById,
  candidates,
  busyId,
  mode,
  onAction,
}: Props) {
  // The search box is local so typing stays responsive; the server query follows after a pause.
  const [search, setSearch] = useState(filters.search);
  useEffect(() => {
    setSearch(filters.search);
  }, [filters.search]);
  useEffect(() => {
    if (search === filters.search) return;
    const timer = setTimeout(() => onFiltersChange({ search }), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search, filters.search, onFiltersChange]);

  const pageRows = transactions;

  return (
    <div className="card overflow-hidden">
      <div className="px-5 py-3 border-b border-slate-200 flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="h-4 w-4 text-slate-400 absolute right-3 top-1/2 -translate-y-1/2" />
          <input
            className="input-base pr-9 py-2"
            placeholder="חיפוש בתיאור, אסמכתא, ספק או סכום"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {mode === 'all' && (
          <select className="input-base py-2 w-auto" value={filters.status} onChange={(e) => onFiltersChange({ status: e.target.value as BankStatusFilter })}>
            <option value="all">כל הסטטוסים</option>
            <option value="debits">חיובים בלבד</option>
            <option value="unmatched">ללא חשבונית</option>
            <option value="auto">הותאם אוטומטית</option>
            <option value="manual">הותאם ידנית</option>
            <option value="ignored">הוחרג</option>
          </select>
        )}
        {accounts.length > 1 && (
          <select
            className="input-base py-2 w-auto"
            value={filters.account ?? '__all__'}
            onChange={(e) => onFiltersChange({ account: e.target.value === '__all__' ? null : e.target.value })}
          >
            <option value="__all__">כל החשבונות</option>
            {accounts.map((a) => (
              <option key={a} value={a}>{a || 'ללא שם'}</option>
            ))}
          </select>
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500 text-xs">
            <tr>
              <th className="text-right font-semibold px-4 py-3">תאריך</th>
              <th className="text-right font-semibold px-4 py-3">חשבון</th>
              <th className="text-right font-semibold px-4 py-3">תיאור</th>
              <th className="text-left font-semibold px-4 py-3">סכום</th>
              <th className="text-right font-semibold px-4 py-3">סטטוס</th>
              <th className="text-right font-semibold px-4 py-3">חשבונית</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {pageRows.length === 0 && (
              <tr>
                <td colSpan={7} className="text-center text-slate-400 py-12">
                  {mode === 'missing' ? 'אין חיובים ללא חשבונית' : 'אין תנועות להצגה'}
                </td>
              </tr>
            )}
            {pageRows.map((t) => {
              const invoice = t.matched_invoice_id ? invoicesById.get(t.matched_invoice_id) : undefined;
              const candidateCount = candidates[t.id]?.length ?? 0;
              const busy = busyId === t.id;
              const isDebit = t.amount < 0;
              return (
                <tr key={t.id} className={clsx('hover:bg-slate-50/60', t.match_status === 'ignored' && 'opacity-60')}>
                  <td className="px-4 py-3 whitespace-nowrap text-slate-700">{formatIsoDateHe(t.txn_date)}</td>
                  <td className="px-4 py-3 whitespace-nowrap text-slate-500 text-xs">{t.account_label}</td>
                  <td className="px-4 py-3 text-slate-800">
                    {t.description}
                    {t.reference && <span className="block text-xs text-slate-400">אסמכתא {t.reference}</span>}
                  </td>
                  <td dir="ltr" className={clsx('px-4 py-3 text-left tabular-nums whitespace-nowrap font-medium', isDebit ? 'text-rose-700' : 'text-emerald-700')}>
                    {formatAmount(t.amount)}
                  </td>
                  <td className="px-4 py-3"><BankStatusBadge transaction={t} /></td>
                  <td className="px-4 py-3 text-xs">
                    {invoice ? (
                      <Link href={`/review/${invoice.id}`} className="text-blue-600 hover:underline">
                        {invoice.supplier_name || invoice.file_name}
                        {invoice.invoice_number && <span className="text-slate-400"> · {invoice.invoice_number}</span>}
                      </Link>
                    ) : t.match_status === 'unmatched' && isDebit && candidateCount > 0 ? (
                      <span className="text-amber-700">{candidateCount === 1 ? 'חשבונית אפשרית אחת' : `${candidateCount} חשבוניות אפשריות`}</span>
                    ) : (
                      <span className="text-slate-300">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      {busy ? (
                        <Loader2 className="h-4 w-4 animate-spin text-slate-400" />
                      ) : (
                        <>
                          {t.match_status === 'unmatched' && isDebit && (
                            <RowButton icon={Link2} label="התאם" onClick={() => onAction(t, 'match')} primary />
                          )}
                          {(t.match_status === 'auto' || t.match_status === 'manual') && (
                            <RowButton icon={Unlink} label="בטל התאמה" onClick={() => onAction(t, 'unmatch')} />
                          )}
                          {t.match_status === 'unmatched' && (
                            <RowButton icon={EyeOff} label="החרג" title="לא נדרשת חשבונית (עמלה, משכורת, העברה...)" onClick={() => onAction(t, 'ignore')} />
                          )}
                          {t.match_status === 'ignored' && (
                            <RowButton icon={RotateCcw} label="שחזר" onClick={() => onAction(t, 'restore')} />
                          )}
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="px-5 py-3 border-t border-slate-200 flex items-center justify-between text-sm text-slate-500">
          <span>
            {((page - 1) * pageSize + 1).toLocaleString('he-IL')}–{Math.min(page * pageSize, total).toLocaleString('he-IL')} מתוך {total.toLocaleString('he-IL')}
          </span>
          <div className="flex items-center gap-1">
            <button
              className="p-1.5 rounded-lg hover:bg-slate-100 disabled:opacity-40"
              disabled={page === 1}
              onClick={() => onPageChange(page - 1)}
              title="הקודם"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
            {getPageNumbers(page, totalPages).map((p, i) =>
              typeof p === 'number' ? (
                <button
                  key={i}
                  onClick={() => onPageChange(p)}
                  className={clsx('min-w-[2rem] h-8 rounded-lg', p === page ? 'bg-blue-600 text-white font-semibold' : 'hover:bg-slate-100')}
                >
                  {p}
                </button>
              ) : (
                <span key={i} className="px-1">{p}</span>
              )
            )}
            <button
              className="p-1.5 rounded-lg hover:bg-slate-100 disabled:opacity-40"
              disabled={page === totalPages}
              onClick={() => onPageChange(page + 1)}
              title="הבא"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function RowButton({
  icon: Icon,
  label,
  title,
  onClick,
  primary = false,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  title?: string;
  onClick: () => void;
  primary?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={title ?? label}
      className={clsx(
        'inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors whitespace-nowrap',
        primary ? 'text-blue-700 bg-blue-50 hover:bg-blue-100' : 'text-slate-600 hover:bg-slate-100'
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}
