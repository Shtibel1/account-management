'use client';

import { useState } from 'react';
import clsx from 'clsx';
import { ChevronDown, ListOrdered, Plus, Trash2, CheckCircle2, AlertTriangle } from 'lucide-react';
import type { LineItem } from '@/shared/types';
import { MAX_LINE_ITEMS, checkLineItemsSum, expectedLineTotal, hasMixedVat, isLineTotalMismatch, lineTotalMismatches, updateLineItem } from '@/shared/lineItems';

interface Props {
  items: LineItem[];
  amountBeforeVat: number | null | undefined;
  totalAmount: number | null | undefined;
  /** Omit for a read-only table. */
  onChange?: (items: LineItem[]) => void;
}

const BASIS_LABEL = { amount_before_vat: 'לסכום לפני מע״מ', total_amount: 'לסה״כ לתשלום' } as const;

const fmt = (n: number | null | undefined) =>
  n == null ? '—' : n.toLocaleString('he-IL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const parseNum = (value: string): number | null => {
  if (value.trim() === '') return null;
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : null;
};

export function LineItemsTable({ items, amountBeforeVat, totalAmount, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const editable = !!onChange;

  const sumCheck = checkLineItemsSum({
    line_items: items,
    amount_before_vat: amountBeforeVat ?? null,
    total_amount: totalAmount ?? null,
  });
  const mixedVat = hasMixedVat(items);
  const rowMismatches = lineTotalMismatches(items);

  // Quantity / unit price edits recompute the line total when it followed them (see updateLineItem)
  const update = (index: number, patch: Partial<LineItem>) =>
    onChange?.(items.map((item, i) => (i === index ? updateLineItem(item, patch) : item)));
  const remove = (index: number) => onChange?.(items.filter((_, i) => i !== index));
  const add = () =>
    onChange?.([...items, { description: null, quantity: null, unit_price: null, line_total: null }]);

  return (
    <div className="border border-slate-200 rounded-xl bg-white overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-3 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 transition-colors focus:outline-none"
        aria-expanded={open}
      >
        <ListOrdered className="h-4 w-4 text-slate-500 shrink-0" />
        <span>שורות פריטים</span>
        <span className="text-xs font-normal text-slate-500">({items.length})</span>
        {sumCheck.ok === true && (
          <span className="flex items-center gap-1 text-[11px] font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded-full">
            <CheckCircle2 className="h-3 w-3" /> תואם
          </span>
        )}
        {sumCheck.ok === false && (
          <span className="flex items-center gap-1 text-[11px] font-medium text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded-full">
            <AlertTriangle className="h-3 w-3" /> לא תואם
          </span>
        )}
        {rowMismatches.length > 0 && (
          <span className="flex items-center gap-1 text-[11px] font-medium text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded-full">
            <AlertTriangle className="h-3 w-3" /> {rowMismatches.length === 1 ? 'שורה אחת' : `${rowMismatches.length} שורות`} לא תואמות לכמות × מחיר
          </span>
        )}
        {mixedVat && (
          <span className="text-[11px] font-medium text-indigo-700 bg-indigo-50 border border-indigo-200 px-1.5 py-0.5 rounded-full">
            מע״מ מעורב
          </span>
        )}
        <ChevronDown className={clsx('h-4 w-4 text-slate-400 mr-auto transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="border-t border-slate-100 animate-in fade-in duration-200">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-slate-500">
                <tr>
                  <th className="px-2 py-1.5 text-right font-semibold">תיאור</th>
                  <th className="px-2 py-1.5 text-right font-semibold w-14">כמות</th>
                  <th className="px-2 py-1.5 text-right font-semibold w-20">מחיר יח׳</th>
                  <th className="px-2 py-1.5 text-right font-semibold w-20">סה״כ</th>
                  <th className="px-2 py-1.5 text-center font-semibold w-12" title="שורה פטורה ממע״מ">פטור</th>
                  {editable && <th className="w-7" />}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {items.map((item, i) => (
                  <tr
                    key={i}
                    className={clsx(item.vat_exempt && 'bg-indigo-50/40', isLineTotalMismatch(item) && 'bg-amber-50/70')}
                    title={isLineTotalMismatch(item) ? `כמות × מחיר ליחידה = ${fmt(expectedLineTotal(item))}, אך סה״כ השורה ${fmt(item.line_total)}` : undefined}
                  >
                    {editable ? (
                      <>
                        <td className="px-1 py-1">
                          <input
                            className="input-base py-1 px-1.5 text-xs"
                            aria-label={`תיאור שורה ${i + 1}`}
                            value={item.description ?? ''}
                            onChange={(e) => update(i, { description: e.target.value || null })}
                          />
                        </td>
                        <td className="px-1 py-1">
                          <input
                            type="number" step="any"
                            className="input-base py-1 px-1.5 text-xs font-mono"
                            aria-label={`כמות שורה ${i + 1}`}
                            value={item.quantity ?? ''}
                            onChange={(e) => update(i, { quantity: parseNum(e.target.value) })}
                          />
                        </td>
                        <td className="px-1 py-1">
                          <input
                            type="number" step="0.01"
                            className="input-base py-1 px-1.5 text-xs font-mono"
                            aria-label={`מחיר ליחידה שורה ${i + 1}`}
                            value={item.unit_price ?? ''}
                            onChange={(e) => update(i, { unit_price: parseNum(e.target.value) })}
                          />
                        </td>
                        <td className="px-1 py-1">
                          <input
                            type="number" step="0.01"
                            className={clsx('input-base py-1 px-1.5 text-xs font-mono', isLineTotalMismatch(item) && 'border-amber-400 bg-amber-50')}
                            aria-invalid={isLineTotalMismatch(item) || undefined}
                            aria-label={`סה״כ שורה ${i + 1}`}
                            value={item.line_total ?? ''}
                            onChange={(e) => update(i, { line_total: parseNum(e.target.value) })}
                          />
                        </td>
                        <td className="px-1 py-1 text-center">
                          <input
                            type="checkbox"
                            className="accent-indigo-600"
                            checked={!!item.vat_exempt}
                            onChange={(e) => update(i, { vat_exempt: e.target.checked || undefined })}
                            aria-label="שורה פטורה ממע״מ"
                          />
                        </td>
                        <td className="px-1 py-1">
                          <button
                            type="button"
                            onClick={() => remove(i)}
                            className="p-1 text-slate-400 hover:text-rose-600 transition-colors"
                            title="מחק שורה"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </td>
                      </>
                    ) : (
                      <>
                        <td className="px-2 py-1.5 text-slate-800">{item.description ?? '—'}</td>
                        <td className="px-2 py-1.5 font-mono text-slate-600">{item.quantity ?? '—'}</td>
                        <td className="px-2 py-1.5 font-mono text-slate-600">{fmt(item.unit_price)}</td>
                        <td className={clsx('px-2 py-1.5 font-mono', isLineTotalMismatch(item) ? 'text-amber-700 font-semibold' : 'text-slate-800')}>{fmt(item.line_total)}</td>
                        <td className="px-2 py-1.5 text-center text-indigo-700">{item.vat_exempt ? '✓' : ''}</td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between gap-2 px-3 py-2 border-t border-slate-100 bg-slate-50/60 text-xs">
            <span className="text-slate-600">
              סכום השורות: <span className="font-mono font-semibold text-slate-800">₪{fmt(sumCheck.sum)}</span>
            </span>
            {sumCheck.ok === true && sumCheck.matched && (
              <span className="text-emerald-700">תואם ל{BASIS_LABEL[sumCheck.matched]}</span>
            )}
            {sumCheck.ok === false && (
              <span className="text-amber-700">
                לא תואם לסכום לפני מע״מ (₪{fmt(amountBeforeVat)}) או לסה״כ לתשלום (₪{fmt(totalAmount)})
              </span>
            )}
          </div>

          {editable && items.length < MAX_LINE_ITEMS && (
            <button
              type="button"
              onClick={add}
              className="w-full flex items-center justify-center gap-1 py-1.5 border-t border-slate-100 text-xs text-blue-700 hover:bg-blue-50 transition-colors"
            >
              <Plus className="h-3.5 w-3.5" /> הוסף שורה
            </button>
          )}
        </div>
      )}
    </div>
  );
}
