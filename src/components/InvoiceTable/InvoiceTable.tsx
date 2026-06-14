'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Invoice } from '@/shared/types';
import { StatusBadge } from '@/components/ui/Badge';
import { exportInvoices, MissingMappingsError } from '@/lib/api';
import { useToast } from '@/components/ui/Toast';
import { format } from 'date-fns';
import { AlertTriangle, Download, ExternalLink, FileText, Loader2, X } from 'lucide-react';

interface Props {
  invoices: Invoice[];
  clients?: Record<string, string>;
  onExported?: () => void;
}

export function InvoiceTable({ invoices, clients = {}, onExported }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);
  const [missingMappings, setMissingMappings] = useState<string[] | null>(null);
  const [clientFilter, setClientFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const { toast } = useToast();

  const uniqueClientIds = Array.from(new Set(invoices.map((i) => i.client_id)));

  const filteredInvoices = invoices.filter((inv) => {
    const matchClient = clientFilter === 'all' || inv.client_id === clientFilter;
    const matchStatus = statusFilter === 'all' || inv.status === statusFilter;
    return matchClient && matchStatus;
  });

  const approved = filteredInvoices.filter((i) => i.status === 'approved');

  const toggleAll = () =>
    selected.size === approved.length
      ? setSelected(new Set())
      : setSelected(new Set(approved.map((i) => i.id)));

  const toggle = (id: string) => {
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelected(next);
  };

  const handleExport = async () => {
    if (!selected.size) return;
    setExporting(true);
    try {
      const blob = await exportInvoices([...selected]);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `יומן_${format(new Date(), 'yyyyMMdd_HHmm')}.txt`;
      a.click();
      URL.revokeObjectURL(url);
      setSelected(new Set());
      setMissingMappings(null);
      onExported?.();
    } catch (err) {
      if (err instanceof MissingMappingsError) {
        setMissingMappings(err.missing);
      } else {
        toast((err as Error).message, 'error');
      }
    } finally {
      setExporting(false);
    }
  };

  if (invoices.length === 0) {
    return (
      <div className="card flex flex-col items-center justify-center py-20 text-center">
        <div className="bg-slate-100 rounded-full p-5 mb-4">
          <FileText className="h-10 w-10 text-slate-400" />
        </div>
        <h3 className="font-semibold text-slate-700">אין חשבוניות עדיין</h3>
        <p className="text-sm text-slate-500 mt-1">
          <a href="/upload" className="text-blue-600 hover:underline">העלה חשבוניות</a> כדי להתחיל
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div className="flex items-center gap-3 px-4 py-3 bg-blue-600 rounded-xl text-white shadow-sm">
          <span className="text-sm font-medium">{selected.size} חשבוניות נבחרו</span>
          <div className="flex-1" />
          <button
            onClick={handleExport} disabled={exporting}
            className="flex items-center gap-2 bg-white text-blue-700 hover:bg-blue-50 disabled:opacity-60 px-4 py-1.5 rounded-lg text-sm font-semibold transition-colors"
          >
            {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            {exporting ? 'מייצא...' : 'ייצא ל-Move-in'}
          </button>
          <button onClick={() => setSelected(new Set())} className="text-white/70 hover:text-white text-sm">
            בטל בחירה
          </button>
        </div>
      )}

      {/* Missing mappings banner */}
      {missingMappings && (
        <div className="flex gap-3 p-4 bg-amber-50 border border-amber-300 rounded-xl text-sm text-amber-900">
          <AlertTriangle className="h-5 w-5 shrink-0 mt-0.5 text-amber-500" />
          <div className="flex-1">
            <p className="font-semibold mb-1">מיפויים חסרים — לא ניתן לייצא</p>
            <ul className="list-disc list-inside space-y-0.5 text-amber-800">
              {missingMappings.map((m) => <li key={m}>{m}</li>)}
            </ul>
            <Link href="/mappings" className="inline-block mt-2 text-amber-700 font-medium underline underline-offset-2 hover:text-amber-900">
              הוסף מיפויים ←
            </Link>
          </div>
          <button onClick={() => setMissingMappings(null)} className="text-amber-400 hover:text-amber-700 self-start">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Filters bar */}
      <div className="flex flex-wrap items-center gap-4 bg-slate-50 p-4 rounded-xl border border-slate-200/60 mb-3" style={{ direction: 'rtl' }}>
        <span className="text-xs font-bold text-slate-500 uppercase tracking-wide">סינון חשבוניות:</span>
        
        {/* Client filter */}
        <div className="flex items-center gap-2">
          <label className="text-xs font-semibold text-slate-600">לקוח:</label>
          <select
            value={clientFilter}
            onChange={(e) => setClientFilter(e.target.value)}
            className="text-xs border border-slate-200 rounded-lg bg-white px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 min-w-[140px] text-right font-medium"
          >
            <option value="all">כל הלקוחות ({invoices.length})</option>
            {uniqueClientIds.map((cid) => (
              <option key={cid} value={cid}>
                {clients[cid] || cid}
              </option>
            ))}
          </select>
        </div>

        {/* Status filter */}
        <div className="flex items-center gap-2">
          <label className="text-xs font-semibold text-slate-600">סטטוס:</label>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="text-xs border border-slate-200 rounded-lg bg-white px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 min-w-[140px] text-right font-medium"
          >
            <option value="all">כל הסטטוסים</option>
            <option value="processing">מעבד...</option>
            <option value="review">לבדיקה</option>
            <option value="approved">אושר</option>
            <option value="rejected">לא אושר</option>
            <option value="exported">יוצא</option>
            <option value="error">חריג</option>
          </select>
        </div>

        {/* Clear filters button */}
        {(clientFilter !== 'all' || statusFilter !== 'all') && (
          <button
            onClick={() => { setClientFilter('all'); setStatusFilter('all'); }}
            className="text-xs text-blue-600 hover:text-blue-700 underline font-semibold mr-auto"
          >
            נקה מסננים
          </button>
        )}
      </div>

      {/* Table */}
      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200">
              <th className="p-4 w-10">
                <input
                  type="checkbox"
                  className="rounded border-slate-300 text-blue-600 accent-blue-600"
                  checked={selected.size === approved.length && approved.length > 0}
                  onChange={toggleAll}
                />
              </th>
              <th className="p-4 text-right font-semibold text-slate-600 text-xs uppercase tracking-wide">לקוח</th>
              <th className="p-4 text-right font-semibold text-slate-600 text-xs uppercase tracking-wide">שם קובץ</th>
              <th className="p-4 text-right font-semibold text-slate-600 text-xs uppercase tracking-wide">תאריך העלאה</th>
              <th className="p-4 text-right font-semibold text-slate-600 text-xs uppercase tracking-wide">ספק</th>
              <th className="p-4 text-right font-semibold text-slate-600 text-xs uppercase tracking-wide">תאריך</th>
              <th className="p-4 text-right font-semibold text-slate-600 text-xs uppercase tracking-wide">סה"כ</th>
              <th className="p-4 text-right font-semibold text-slate-600 text-xs uppercase tracking-wide">קטגוריה</th>
              <th className="p-4 text-right font-semibold text-slate-600 text-xs uppercase tracking-wide">סטטוס</th>
              <th className="p-4 w-16"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {filteredInvoices.length === 0 ? (
              <tr>
                <td colSpan={10} className="p-8 text-center text-slate-400 font-medium">
                  לא נמצאו חשבוניות התואמות את הסינון המבוקש.
                </td>
              </tr>
            ) : (
              filteredInvoices.map((inv) => {
              const data = inv.validated_data ?? inv.extracted_data;
              const isSelectable = inv.status === 'approved';
              return (
                <tr key={inv.id} className="hover:bg-slate-50/60 transition-colors group">
                  <td className="p-4">
                    {isSelectable && (
                      <input
                        type="checkbox"
                        className="rounded border-slate-300 accent-blue-600"
                        checked={selected.has(inv.id)}
                        onChange={() => toggle(inv.id)}
                      />
                    )}
                  </td>
                  <td className="p-4 text-slate-700 font-medium">
                    {clients[inv.client_id] || <span className="text-slate-400">—</span>}
                  </td>
                  <td className="p-4">
                    <div className="flex items-center gap-2">
                      <FileText className="h-4 w-4 text-slate-400 shrink-0 self-start mt-0.5" />
                      <div className="flex flex-col min-w-0">
                        <span className="text-slate-700 font-medium max-w-[160px] truncate" title={inv.file_name}>{inv.file_name}</span>
                        {inv.status === 'error' && inv.error_message && (
                          <span className="text-xs text-red-500 font-normal max-w-[200px] truncate mt-0.5" title={inv.error_message}>
                            {inv.error_message}
                          </span>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="p-4 text-slate-500 tabular-nums">
                    {inv.created_at ? format(new Date(inv.created_at), 'dd/MM/yyyy') : <span className="text-slate-400">—</span>}
                  </td>
                  <td className="p-4 text-slate-700">{data?.supplier_name ?? <span className="text-slate-400">—</span>}</td>
                  <td className="p-4 text-slate-500 tabular-nums">
                    {data?.invoice_date
                      ? data.invoice_date.split('-').reverse().join('/')
                      : <span className="text-slate-400">—</span>}
                  </td>
                  <td className="p-4 text-slate-800 font-semibold tabular-nums">
                    {data?.total_amount != null
                      ? `₪${data.total_amount.toLocaleString('he-IL', { minimumFractionDigits: 2 })}`
                      : <span className="text-slate-400 font-normal">—</span>}
                  </td>
                  <td className="p-4">
                    {data?.expense_category
                      ? <span className="text-xs bg-slate-100 text-slate-600 px-2.5 py-1 rounded-full font-medium">{data.expense_category}</span>
                      : <span className="text-slate-400">—</span>}
                  </td>
                  <td className="p-4"><StatusBadge status={inv.status} /></td>
                  <td className="p-4">
                    {(inv.status === 'review' || inv.status === 'approved') && (
                      <Link
                        href={`/review/${inv.id}`}
                        className="flex items-center gap-1 text-blue-600 hover:text-blue-700 opacity-0 group-hover:opacity-100 transition-opacity text-xs font-medium"
                      >
                        פתח <ExternalLink className="h-3 w-3" />
                      </Link>
                    )}
                  </td>
                </tr>
              );
            }))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
