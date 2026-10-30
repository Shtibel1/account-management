'use client';

import { useMemo, useState } from 'react';
import clsx from 'clsx';
import { Search, Sparkles, X } from 'lucide-react';
import type { BankTransaction, MatchableInvoice } from '@/shared/types';
import { formatIsoDateHe } from '@/lib/exporters/missingInvoices';
import { formatAmount } from '@/components/Bank/format';
import { useEscapeKey } from '@/components/ui/useEscapeKey';

interface Props {
  transaction: BankTransaction;
  /** Approved/exported invoices not matched to any other line. */
  available: MatchableInvoice[];
  candidateIds: string[];
  onSelect: (invoiceId: string) => void;
  onClose: () => void;
}

const MAX_LIST = 50;

/** Manual match: suggested candidates first, then every free invoice ordered by amount closeness. */
export function MatchPicker({ transaction, available, candidateIds, onSelect, onClose }: Props) {
  const [query, setQuery] = useState('');
  const target = Math.abs(transaction.amount);

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rank = new Map(candidateIds.map((id, i) => [id, i]));
    return available
      .filter((inv) => {
        if (!q) return true;
        return [inv.supplier_name, inv.invoice_number, inv.file_name, inv.total_amount?.toString()]
          .some((v) => v?.toLowerCase().includes(q));
      })
      .sort((a, b) => {
        const ra = rank.get(a.id) ?? Infinity;
        const rb = rank.get(b.id) ?? Infinity;
        if (ra !== rb) return ra - rb;
        return Math.abs((a.total_amount ?? 0) - target) - Math.abs((b.total_amount ?? 0) - target);
      })
      .slice(0, MAX_LIST);
  }, [available, candidateIds, query, target]);

  const candidateSet = new Set(candidateIds);

  useEscapeKey(onClose);

  return (
    <div className="fixed inset-0 z-40 bg-slate-900/40 flex items-center justify-center p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label="התאמת חשבונית לתנועה" className="card w-full max-w-2xl max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-slate-200 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="font-bold text-slate-900">התאמת חשבונית לתנועה</h3>
            <p className="text-sm text-slate-500 mt-0.5 truncate">
              {formatIsoDateHe(transaction.txn_date)} · {transaction.description} ·{' '}
              <span dir="ltr" className="font-semibold text-rose-700">{formatAmount(transaction.amount)}</span>
            </p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600" title="סגור">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-5 py-3 border-b border-slate-100">
          <div className="relative">
            <Search className="h-4 w-4 text-slate-400 absolute right-3 top-1/2 -translate-y-1/2" />
            <input
              autoFocus
              className="input-base pr-9"
              placeholder="חיפוש לפי ספק, מספר חשבונית או סכום"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </div>

        <div className="overflow-y-auto divide-y divide-slate-100">
          {list.length === 0 && (
            <p className="text-sm text-slate-400 text-center py-10">אין חשבוניות מאושרות פנויות ללקוח הזה</p>
          )}
          {list.map((inv) => {
            const diff = inv.total_amount == null ? null : Math.abs(inv.total_amount - target);
            return (
              <button
                key={inv.id}
                onClick={() => onSelect(inv.id)}
                className="w-full text-right px-5 py-3 hover:bg-blue-50/60 transition-colors flex items-center gap-3"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-slate-800 truncate">{inv.supplier_name || inv.file_name}</span>
                    {candidateSet.has(inv.id) && (
                      <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-blue-700 bg-blue-50 border border-blue-200 rounded-full px-2 py-0.5 shrink-0">
                        <Sparkles className="h-3 w-3" /> מוצעת
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-slate-500 mt-0.5">
                    {inv.invoice_number ? `חשבונית ${inv.invoice_number} · ` : ''}
                    {inv.invoice_date ? formatIsoDateHe(inv.invoice_date) : 'ללא תאריך'}
                  </p>
                </div>
                <span
                  dir="ltr"
                  className={clsx('tabular-nums text-sm font-semibold shrink-0', diff != null && diff <= 0.5 ? 'text-emerald-700' : 'text-slate-700')}
                >
                  {inv.total_amount == null ? '—' : formatAmount(inv.total_amount)}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
