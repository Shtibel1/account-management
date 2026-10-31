'use client';

import { useState, useEffect } from 'react';
import { useListFilters } from './listFilters';
import Link from 'next/link';
import { Invoice } from '@/shared/types';
import { StatusBadge } from '@/components/ui/Badge';
import { exportInvoices, MissingMappingsError } from '@/lib/api';
import { useToast } from '@/components/ui/Toast';
import { format } from 'date-fns';
import { AlertTriangle, ChevronLeft, ChevronRight, Download, ExternalLink, FileText, Loader2, Plug, X } from 'lucide-react';
import { IntegrationExportDialog } from '@/components/Integrations/IntegrationExportDialog';
import { processingLabel } from '@/components/Processing/ProcessingStatus';
import { toUserErrorMessage } from '@/shared/processing';
import { inDateRange } from '@/shared/invoiceDateRange';

interface Props {
  invoices: Invoice[];
  clients?: Record<string, string>;
  onExported?: () => void;
  /** Accountant review loop flag: offers the "הוחזר ללקוח" status filter. */
  showReturned?: boolean;
}

function getPageNumbers(currentPage: number, totalPages: number) {
  const pages: (number | string)[] = [];
  if (totalPages <= 5) {
    for (let i = 1; i <= totalPages; i++) {
      pages.push(i);
    }
  } else {
    if (currentPage <= 3) {
      pages.push(1, 2, 3, 4, '...', totalPages);
    } else if (currentPage >= totalPages - 2) {
      pages.push(1, '...', totalPages - 3, totalPages - 2, totalPages - 1, totalPages);
    } else {
      pages.push(1, '...', currentPage - 1, currentPage, currentPage + 1, '...', totalPages);
    }
  }
  return pages;
}

/** Ellipsis in the middle, so both the start and the extension of a long file name stay visible. */
function MiddleTruncate({ text, className }: { text: string; className?: string }) {
  const TAIL = 12;
  const head = text.length > TAIL + 4 ? text.slice(0, -TAIL) : text;
  const tail = head === text ? '' : text.slice(-TAIL);
  return (
    <span dir="auto" title={text} className={`flex min-w-0 ${className ?? ''}`}>
      <span className="truncate">{head}</span>
      {tail && <span className="shrink-0 whitespace-pre">{tail}</span>}
    </span>
  );
}

export function InvoiceTable({ invoices, clients = {}, onExported, showReturned = false }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);
  const [missingMappings, setMissingMappings] = useState<string[] | null>(null);
  // Remembered across leaving the list (open / split / approve an invoice) and in the URL
  const { clientFilter, setClientFilter, statusFilter, setStatusFilter } = useListFilters();
  // Invoice-date range (YYYY-MM-DD, inclusive), e.g. to export one month to Move-in (QA-MV B4)
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [integrationExport, setIntegrationExport] = useState<{ clientId: string; invoices: Invoice[] } | null>(null);
  const { toast } = useToast();

  const [currentPage, setCurrentPage] = useState(1);
  const ITEMS_PER_PAGE = 10;

  useEffect(() => {
    setCurrentPage(1);
  }, [clientFilter, statusFilter, dateFrom, dateTo]);

  // Every client of the office (also those without invoices yet), then any other client an invoice has
  const uniqueClientIds = Array.from(new Set([
    ...Object.keys(clients).sort((a, b) => (clients[a] || '').localeCompare(clients[b] || '', 'he')),
    ...invoices.map((i) => i.client_id),
  ]));

  const filteredInvoices = invoices.filter((inv) => {
    const matchClient = clientFilter === 'all' || inv.client_id === clientFilter;
    const matchStatus = statusFilter === 'all' || inv.status === statusFilter;
    return matchClient && matchStatus && inDateRange(inv, dateFrom, dateTo);
  });
  const filterKey = filteredInvoices.map((i) => i.id).join(',');

  // A selection never includes invoices the filters hide: narrowing the date range after "select
  // all" must not export the hidden invoices (QA-MV B4).
  useEffect(() => {
    const visible = new Set(filterKey.split(','));
    setSelected((prev) => {
      const next = new Set([...prev].filter((id) => visible.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [filterKey]);

  const totalItems = filteredInvoices.length;
  const totalPages = Math.ceil(totalItems / ITEMS_PER_PAGE);
  const safeCurrentPage = Math.min(currentPage, Math.max(1, totalPages));
  const startIndex = (safeCurrentPage - 1) * ITEMS_PER_PAGE;
  const endIndex = startIndex + ITEMS_PER_PAGE;
  const paginatedInvoices = filteredInvoices.slice(startIndex, endIndex);

  const approved = filteredInvoices.filter((i) => i.status === 'approved');
  const selectedApproved = approved.filter((i) => selected.has(i.id)).length;

  const toggleAll = () =>
    selectedApproved === approved.length && approved.length > 0
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
      const { blob, skipped, skippedCount, exportedCount } = await exportInvoices([...selected]);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'movein.dat';
      a.click();
      // Revoking in the same tick can cancel the download in some browsers
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setSelected(new Set());
      setMissingMappings(null);
      if (exportedCount > 0) toast(`הקובץ movein.dat ירד: ${exportedCount} חשבוניות יוצאו ל-Move-in`, 'success');
      if (skippedCount > 0) {
        toast(`${skippedCount} חשבוניות לא נכללו בקובץ: ${skipped.join(' · ')}`, 'error');
      }
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

  const handleIntegrationExport = () => {
    const chosen = invoices.filter((i) => selected.has(i.id));
    const clientIds = [...new Set(chosen.map((i) => i.client_id))];
    if (clientIds.length !== 1) {
      toast('יש לבחור חשבוניות של לקוח אחד בכל פעם', 'error');
      return;
    }
    setIntegrationExport({ clientId: clientIds[0], invoices: chosen });
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
          <button
            onClick={handleIntegrationExport}
            className="flex items-center gap-2 bg-blue-500 hover:bg-blue-400 text-white px-4 py-1.5 rounded-lg text-sm font-semibold transition-colors"
          >
            <Plug className="h-4 w-4" />
            ייצוא להנהלת חשבונות
          </button>
          <button onClick={() => setSelected(new Set())} className="text-white/70 hover:text-white text-sm">
            בטל בחירה
          </button>
        </div>
      )}

      {integrationExport && (
        <IntegrationExportDialog
          clientId={integrationExport.clientId}
          clientName={clients[integrationExport.clientId]}
          invoices={integrationExport.invoices}
          onClose={() => setIntegrationExport(null)}
          onExported={() => { setSelected(new Set()); onExported?.(); }}
        />
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
          <label htmlFor="invoice-filter-client" className="text-xs font-semibold text-slate-600">לקוח:</label>
          <select
            id="invoice-filter-client"
            value={clientFilter}
            onChange={(e) => setClientFilter(e.target.value)}
            className="text-xs border border-slate-200 rounded-lg bg-white px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 min-w-[140px] max-w-[220px] text-right font-medium"
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
          <label htmlFor="invoice-filter-status" className="text-xs font-semibold text-slate-600">סטטוס:</label>
          <select
            id="invoice-filter-status"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="text-xs border border-slate-200 rounded-lg bg-white px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 min-w-[140px] max-w-[220px] text-right font-medium"
          >
            <option value="all">כל הסטטוסים</option>
            <option value="processing">מעבד...</option>
            <option value="review">לבדיקה</option>
            <option value="approved">אושר</option>
            <option value="rejected">לא אושר</option>
            <option value="exported">יוצא</option>
            {showReturned && (
              <option value="returned">
                הוחזר ללקוח ({invoices.filter((i) => i.status === 'returned').length})
              </option>
            )}
            <option value="error">חריג</option>
          </select>
        </div>

        {/* Invoice-date range */}
        <div className="flex items-center gap-2">
          <label htmlFor="invoice-filter-date-from" className="text-xs font-semibold text-slate-600">מתאריך:</label>
          <input
            id="invoice-filter-date-from"
            type="date"
            value={dateFrom}
            max={dateTo || undefined}
            onChange={(e) => setDateFrom(e.target.value)}
            className="text-xs border border-slate-200 rounded-lg bg-white px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 font-medium"
          />
          <label htmlFor="invoice-filter-date-to" className="text-xs font-semibold text-slate-600">עד:</label>
          <input
            id="invoice-filter-date-to"
            type="date"
            value={dateTo}
            min={dateFrom || undefined}
            onChange={(e) => setDateTo(e.target.value)}
            className="text-xs border border-slate-200 rounded-lg bg-white px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 font-medium"
          />
        </div>

        {/* Clear filters button */}
        {(clientFilter !== 'all' || statusFilter !== 'all' || dateFrom || dateTo) && (
          <button
            onClick={() => { setClientFilter('all'); setStatusFilter('all'); setDateFrom(''); setDateTo(''); }}
            className="text-xs text-blue-600 hover:text-blue-700 underline font-semibold mr-auto"
          >
            נקה מסננים
          </button>
        )}
      </div>

      <div className="card overflow-hidden">
        {/* Phones (<640px): one stacked card per invoice instead of the wide table */}
        <div className="sm:hidden" style={{ direction: 'rtl' }}>
          {approved.length > 0 && (
            <label className="flex items-center gap-2 px-4 py-3 bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-600">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-slate-300 accent-blue-600"
                checked={selectedApproved === approved.length}
                onChange={toggleAll}
              />
              בחירת כל החשבוניות המאושרות ({approved.length})
            </label>
          )}
          {filteredInvoices.length === 0 ? (
            <p className="p-8 text-center text-slate-400 font-medium">לא נמצאו חשבוניות התואמות את הסינון המבוקש.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {paginatedInvoices.map((inv) => {
                const data = inv.validated_data ?? inv.extracted_data;
                const isSelectable = inv.status === 'approved' || inv.status === 'exported';
                const date = data?.invoice_date
                  ? data.invoice_date.split('-').reverse().join('/')
                  : inv.created_at ? format(new Date(inv.created_at), 'dd/MM/yyyy') : null;
                return (
                  <li key={inv.id} data-testid="invoice-card" className="relative px-4 py-3 hover:bg-slate-50 active:bg-slate-100 transition-colors">
                    {/* The whole card opens the invoice; the checkbox sits above this link */}
                    <Link
                      href={`/review/${inv.id}`}
                      aria-label={`פתח את ${inv.file_name}`}
                      className="absolute inset-0 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-blue-600"
                    />
                    <div className="pointer-events-none space-y-1.5">
                      <div className="flex items-center gap-2 min-w-0">
                        {isSelectable && (
                          <input
                            type="checkbox"
                            aria-label={`בחירת ${inv.file_name}`}
                            className="pointer-events-auto relative z-10 h-5 w-5 shrink-0 rounded border-slate-300 accent-blue-600"
                            checked={selected.has(inv.id)}
                            onChange={() => toggle(inv.id)}
                          />
                        )}
                        <MiddleTruncate text={inv.file_name} className="flex-1 text-sm font-semibold text-slate-800" />
                        <span className="shrink-0"><StatusBadge status={inv.status} /></span>
                      </div>
                      <div className="flex items-center gap-2 min-w-0 text-xs text-slate-500">
                        <span className="truncate text-slate-700 font-medium">{data?.supplier_name ?? 'ספק לא ידוע'}</span>
                        {clients[inv.client_id] && (
                          <>
                            <span className="text-slate-300 shrink-0">·</span>
                            <span className="truncate">{clients[inv.client_id]}</span>
                          </>
                        )}
                      </div>
                      <div className="flex items-center justify-between gap-2 text-xs">
                        <span className="text-sm font-semibold text-slate-800 tabular-nums">
                          {data?.total_amount != null
                            ? `₪${data.total_amount.toLocaleString('he-IL', { minimumFractionDigits: 2 })}`
                            : <span className="text-slate-400 font-normal">—</span>}
                        </span>
                        <span className="text-slate-500 tabular-nums">{date ?? '—'}</span>
                      </div>
                      {showReturned && inv.status === 'returned' && inv.return_reason && (
                        <p className="text-xs text-orange-600 truncate">{inv.return_reason}</p>
                      )}
                      {inv.status === 'processing' && <p className="text-xs text-blue-600 truncate">{processingLabel(inv)}</p>}
                      {inv.status === 'error' && inv.error_message && (
                        <p className="text-xs text-red-500 truncate">{toUserErrorMessage(inv.error_message)}</p>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Table (from 640px) */}
        <div className="hidden sm:block overflow-x-auto">
        <table className="w-full min-w-[760px] text-sm">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200">
              <th className="p-4 w-10">
                <input
                  type="checkbox"
                  className="rounded border-slate-300 text-blue-600 accent-blue-600"
                  checked={selectedApproved === approved.length && approved.length > 0}
                  disabled={approved.length === 0}
                  title={approved.length === 0 ? 'אין חשבוניות מאושרות לייצוא בתצוגה' : 'בחירת כל החשבוניות המאושרות'}
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
              paginatedInvoices.map((inv) => {
              const data = inv.validated_data ?? inv.extracted_data;
              // Exported invoices can be selected too: "ייצוא להנהלת חשבונות" > Move-in with "ייצוא
              // חוזר" downloads their file again (QA-MV B3). "ייצא ל-Move-in" never re-exports them.
              const isSelectable = inv.status === 'approved' || inv.status === 'exported';
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
                        <span className="text-slate-700 font-medium max-w-[160px] truncate" title={inv.file_name}><bdi>{inv.file_name}</bdi></span>
                        {showReturned && inv.status === 'returned' && inv.return_reason && (
                          <span className="text-xs text-orange-600 font-normal max-w-[200px] truncate mt-0.5" title={inv.return_reason}>
                            {inv.return_reason}
                          </span>
                        )}
                        {inv.status === 'processing' && (
                          <span className="text-xs text-blue-600 font-normal max-w-[200px] truncate mt-0.5">
                            {processingLabel(inv)}
                          </span>
                        )}
                        {inv.status === 'error' && inv.error_message && (
                          <span className="text-xs text-red-500 font-normal max-w-[200px] truncate mt-0.5" title={toUserErrorMessage(inv.error_message)}>
                            {/* older rows may still hold raw vendor errors: always show the Hebrew form */}
                            {toUserErrorMessage(inv.error_message)}
                          </span>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="p-4 text-slate-500 tabular-nums">
                    {inv.created_at ? format(new Date(inv.created_at), 'dd/MM/yyyy HH:mm') : <span className="text-slate-400">—</span>}
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
                    {/* Also while processing: the review screen shows progress and lets the user wait or act */}
                    {(
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
        {/* Pagination controls */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between border-t border-slate-200 bg-white px-4 py-3 sm:px-6" style={{ direction: 'rtl' }}>
            {/* Mobile layout */}
            <div className="flex flex-1 justify-between sm:hidden">
              <button
                onClick={() => setCurrentPage((prev) => Math.max(prev - 1, 1))}
                disabled={safeCurrentPage === 1}
                className="relative inline-flex items-center rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                הקודם
              </button>
              <button
                onClick={() => setCurrentPage((prev) => Math.min(prev + 1, totalPages))}
                disabled={safeCurrentPage === totalPages}
                className="relative ml-3 inline-flex items-center rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                הבא
              </button>
            </div>

            {/* Desktop layout */}
            <div className="hidden sm:flex sm:flex-1 sm:items-center sm:justify-between">
              <div>
                <p className="text-sm text-slate-700 gap-1 flex items-center">
                  מציג
                  <span className="font-semibold">{startIndex + 1}</span>
                  עד
                  <span className="font-semibold">{Math.min(endIndex, totalItems)}</span>
                  מתוך
                  <span className="font-semibold">{totalItems}</span>
                  תוצאות
                </p>
              </div>
              <div>
                <nav className="isolate inline-flex -space-x-px rounded-md shadow-sm gap-1" aria-label="Pagination">
                  <button
                    onClick={() => setCurrentPage((prev) => Math.max(prev - 1, 1))}
                    disabled={safeCurrentPage === 1}
                    className="relative inline-flex items-center rounded-lg border border-slate-200 bg-white p-2 text-slate-500 hover:bg-slate-50 focus:z-20 focus:outline-offset-0 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    <span className="sr-only">הקודם</span>
                    <ChevronRight className="h-4 w-4" />
                  </button>
                  {/* Page numbers */}
                  {getPageNumbers(safeCurrentPage, totalPages).map((page, index) => {
                    if (page === '...') {
                      return (
                        <span
                          key={`ellipsis-${index}`}
                          className="relative inline-flex items-center px-3 py-2 text-sm font-semibold text-slate-500 focus:outline-offset-0"
                        >
                          ...
                        </span>
                      );
                    }
                    return (
                      <button
                        key={page}
                        onClick={() => setCurrentPage(page as number)}
                        className={`relative inline-flex items-center rounded-lg px-4 py-2 text-sm font-semibold transition-all ${
                          safeCurrentPage === page
                            ? 'bg-blue-600 text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600'
                            : 'text-slate-900 border border-slate-200 bg-white hover:bg-slate-50 focus:outline-offset-0'
                        }`}
                      >
                        {page}
                      </button>
                    );
                  })}
                  <button
                    onClick={() => setCurrentPage((prev) => Math.min(prev + 1, totalPages))}
                    disabled={safeCurrentPage === totalPages}
                    className="relative inline-flex items-center rounded-lg border border-slate-200 bg-white p-2 text-slate-500 hover:bg-slate-50 focus:z-20 focus:outline-offset-0 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    <span className="sr-only">הבא</span>
                    <ChevronLeft className="h-4 w-4" />
                  </button>
                </nav>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
