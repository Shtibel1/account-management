'use client';

import { useCallback, useEffect, useState } from 'react';
import clsx from 'clsx';
import { format } from 'date-fns';
import { Loader2, RefreshCw, ScrollText, X } from 'lucide-react';
import type { IntegrationLogRecord, PluginInfo } from '@/integrations/types';
import {
  fetchIntegrationLog,
  fetchIntegrationLogs,
  fetchPlugins,
  type IntegrationLogListItem,
  type LogFilters,
} from '@/lib/integrationsApi';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';

const OUTCOME_STYLES: Record<string, { label: string; className: string }> = {
  ok: { label: 'הצליח', className: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  retry: { label: 'ניסיון חוזר', className: 'bg-amber-50 text-amber-700 border-amber-200' },
  error: { label: 'שגיאה', className: 'bg-red-50 text-red-700 border-red-200' },
};

const OPERATION_LABELS: Record<string, string> = {
  test_connection: 'בדיקת חיבור',
  export_invoice: 'ייצוא חשבונית',
  export_file: 'ייצוא קובץ',
  export_decision: 'החלטת ייצוא',
  export_validation: 'בדיקת תקינות',
  find_existing: 'חיפוש מסמך קיים',
};

function OutcomeBadge({ outcome }: { outcome: string }) {
  const s = OUTCOME_STYLES[outcome] ?? { label: outcome, className: 'bg-slate-100 text-slate-600 border-slate-200' };
  return <span className={clsx('text-xs border rounded-full px-2 py-0.5 whitespace-nowrap', s.className)}>{s.label}</span>;
}

function pretty(text: string | null): string {
  if (!text) return '';
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function LogDrawer({ id, onClose, onFilterCorrelation }: { id: string; onClose: () => void; onFilterCorrelation: (c: string) => void }) {
  const { toast } = useToast();
  const [log, setLog] = useState<IntegrationLogRecord | null>(null);

  useEffect(() => {
    setLog(null);
    fetchIntegrationLog(id).then(setLog).catch((err) => {
      console.error('[IntegrationLogs] Failed to load log row:', err);
      toast(err instanceof Error ? err.message : 'שגיאה בטעינת הרשומה', 'error');
      onClose();
    });
  }, [id, onClose, toast]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const row = (label: string, value: React.ReactNode, ltr = false) => (
    <div className="grid grid-cols-[8rem_1fr] gap-2 py-1.5 text-sm">
      <span className="text-slate-500">{label}</span>
      <span className={clsx('text-slate-800 break-all', ltr && 'font-mono text-xs text-left')} dir={ltr ? 'ltr' : undefined}>{value ?? '—'}</span>
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex" style={{ direction: 'rtl' }} onClick={onClose}>
      <div className="flex-1 bg-slate-900/30 backdrop-blur-[1px]" />
      <aside
        className="w-full max-w-2xl h-full bg-white shadow-2xl overflow-y-auto order-first"
        onClick={(e) => e.stopPropagation()}
        role="dialog" aria-label="פרטי קריאה"
      >
        <div className="sticky top-0 bg-white border-b border-slate-100 px-6 py-4 flex items-center justify-between">
          <h3 className="text-lg font-bold text-slate-900">פרטי קריאה</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600" aria-label="סגור"><X className="h-5 w-5" /></button>
        </div>
        {!log ? (
          <div className="flex items-center justify-center py-24 text-slate-400"><Loader2 className="h-7 w-7 animate-spin" /></div>
        ) : (
          <div className="px-6 py-4 space-y-5">
            <div className="divide-y divide-slate-50">
              {row('זמן', format(new Date(log.created_at), 'dd/MM/yyyy HH:mm:ss'))}
              {row('תוצאה', <OutcomeBadge outcome={log.outcome} />)}
              {row('פעולה', OPERATION_LABELS[log.operation] ?? log.operation)}
              {row('תוסף', log.plugin_id, true)}
              {row('בקשה', log.http_method ? `${log.http_method} ${log.url ?? ''}` : null, true)}
              {row('סטטוס HTTP', log.response_status, true)}
              {row('משך', log.duration_ms != null ? `${log.duration_ms} ms` : null)}
              {row('ניסיון', log.attempt)}
              {row('חשבונית', log.invoice_id ? <a className="text-blue-600 hover:underline" href={`/review/${log.invoice_id}`}>{log.invoice_id}</a> : null, true)}
              {row('מזהה ריצה', (
                <button type="button" className="text-blue-600 hover:underline" onClick={() => onFilterCorrelation(log.correlation_id)}>
                  {log.correlation_id}
                </button>
              ), true)}
              {(log.error_code || log.error_message) && row('שגיאה', `${log.error_code ?? ''} ${log.error_message ?? ''}`.trim(), true)}
            </div>
            <section>
              <h4 className="text-sm font-semibold text-slate-800 mb-2">גוף הבקשה (מוסתר מסודות, עד 20KB)</h4>
              <pre dir="ltr" className="bg-slate-900 text-slate-100 text-xs rounded-xl p-4 overflow-x-auto max-h-96 whitespace-pre-wrap break-all">
                {pretty(log.request_body) || '—'}
              </pre>
            </section>
            <section>
              <h4 className="text-sm font-semibold text-slate-800 mb-2">גוף התשובה (עד 20KB)</h4>
              <pre dir="ltr" className="bg-slate-900 text-slate-100 text-xs rounded-xl p-4 overflow-x-auto max-h-96 whitespace-pre-wrap break-all">
                {pretty(log.response_body) || '—'}
              </pre>
            </section>
          </div>
        )}
      </aside>
    </div>
  );
}

export interface LogFilterState {
  pluginId: string;
  outcome: string;
  invoiceId: string;
  correlationId: string;
}

/** "יומן אינטגרציות" table for one client with filters + detail drawer. */
export function IntegrationLogs({
  clientId,
  filters,
  onFiltersChange,
}: {
  clientId: string;
  filters: LogFilterState;
  onFiltersChange: (f: LogFilterState) => void;
}) {
  const { toast } = useToast();
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [logs, setLogs] = useState<IntegrationLogListItem[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [invoiceDraft, setInvoiceDraft] = useState(filters.invoiceId);

  useEffect(() => { setInvoiceDraft(filters.invoiceId); }, [filters.invoiceId]);

  useEffect(() => {
    fetchPlugins().then((d) => setPlugins(d.plugins)).catch((err) => console.error('[IntegrationLogs] Failed to load plugins:', err));
  }, []);

  const load = useCallback(async (before: string | null) => {
    setLoading(true);
    try {
      const query: LogFilters = { ...filters, before, limit: 50 };
      const data = await fetchIntegrationLogs(clientId, query);
      setLogs((prev) => (before ? [...prev, ...data.logs] : data.logs));
      setNextBefore(data.nextBefore);
    } catch (err) {
      console.error('[IntegrationLogs] Failed to load logs:', err);
      toast(err instanceof Error ? err.message : 'שגיאה בטעינת היומן', 'error');
    } finally {
      setLoading(false);
    }
  }, [clientId, filters, toast]);

  useEffect(() => { load(null); }, [load]);

  const pluginName = (id: string) => plugins.find((p) => p.id === id)?.displayName ?? id;
  const closeDrawer = useCallback(() => setOpenId(null), []);
  const hasFilters = Object.values(filters).some(Boolean);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-4 bg-slate-50 p-4 rounded-xl border border-slate-200/60">
        <span className="text-xs font-bold text-slate-500">סינון:</span>
        <div className="flex items-center gap-2">
          <label className="text-xs font-semibold text-slate-600" htmlFor="log-plugin">מערכת:</label>
          <select
            id="log-plugin" value={filters.pluginId}
            onChange={(e) => onFiltersChange({ ...filters, pluginId: e.target.value })}
            className="text-xs border border-slate-200 rounded-lg bg-white px-2.5 py-1.5 min-w-[140px]"
          >
            <option value="">הכול</option>
            {plugins.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs font-semibold text-slate-600" htmlFor="log-outcome">תוצאה:</label>
          <select
            id="log-outcome" value={filters.outcome}
            onChange={(e) => onFiltersChange({ ...filters, outcome: e.target.value })}
            className="text-xs border border-slate-200 rounded-lg bg-white px-2.5 py-1.5 min-w-[120px]"
          >
            <option value="">הכול</option>
            <option value="ok">הצליח</option>
            <option value="retry">ניסיון חוזר</option>
            <option value="error">שגיאה</option>
          </select>
        </div>
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => { e.preventDefault(); onFiltersChange({ ...filters, invoiceId: invoiceDraft.trim() }); }}
        >
          <label className="text-xs font-semibold text-slate-600" htmlFor="log-invoice">חשבונית:</label>
          <input
            id="log-invoice" dir="ltr" value={invoiceDraft} onChange={(e) => setInvoiceDraft(e.target.value)}
            placeholder="מזהה חשבונית"
            className="text-xs border border-slate-200 rounded-lg bg-white px-2.5 py-1.5 w-72 font-mono text-left"
          />
        </form>
        {filters.correlationId && (
          <span className="text-xs bg-blue-50 text-blue-700 border border-blue-100 rounded-full px-2.5 py-1 flex items-center gap-1" dir="ltr">
            run {filters.correlationId.slice(0, 8)}
            <button type="button" aria-label="הסר סינון ריצה" onClick={() => onFiltersChange({ ...filters, correlationId: '' })}><X className="h-3 w-3" /></button>
          </span>
        )}
        <div className="flex-1" />
        {hasFilters && (
          <button
            onClick={() => onFiltersChange({ pluginId: '', outcome: '', invoiceId: '', correlationId: '' })}
            className="text-xs text-blue-600 hover:text-blue-700 underline font-semibold"
          >
            נקה מסננים
          </button>
        )}
        <button
          onClick={() => load(null)} disabled={loading}
          className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-700 px-2 py-1 rounded-lg hover:bg-slate-100"
        >
          <RefreshCw className={clsx('h-3.5 w-3.5', loading && 'animate-spin')} /> רענן
        </button>
      </div>

      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200">
              {['זמן', 'מערכת', 'פעולה', 'בקשה', 'סטטוס', 'משך', 'ניסיון', 'תוצאה', 'שגיאה'].map((h) => (
                <th key={h} className="p-3 text-right font-semibold text-slate-600 text-xs">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {logs.length === 0 ? (
              <tr>
                <td colSpan={9} className="p-12 text-center text-slate-400">
                  {loading ? <Loader2 className="h-6 w-6 animate-spin inline" /> : (
                    <span className="inline-flex flex-col items-center gap-2">
                      <ScrollText className="h-8 w-8 text-slate-300" />
                      אין רשומות ביומן{hasFilters ? ' התואמות את הסינון' : ''}
                    </span>
                  )}
                </td>
              </tr>
            ) : logs.map((log) => (
              <tr key={log.id} onClick={() => setOpenId(log.id)} className="hover:bg-slate-50/60 cursor-pointer">
                <td className="p-3 text-slate-500 tabular-nums whitespace-nowrap">{format(new Date(log.created_at), 'dd/MM HH:mm:ss')}</td>
                <td className="p-3 text-slate-700">{pluginName(log.plugin_id)}</td>
                <td className="p-3 text-slate-700">{OPERATION_LABELS[log.operation] ?? log.operation}</td>
                <td className="p-3 font-mono text-xs text-slate-500 max-w-[260px] truncate text-left" dir="ltr" title={log.url ?? undefined}>
                  {log.http_method ? `${log.http_method} ${log.url ?? ''}` : '—'}
                </td>
                <td className="p-3 tabular-nums text-slate-700">{log.response_status ?? '—'}</td>
                <td className="p-3 tabular-nums text-slate-500 whitespace-nowrap">{log.duration_ms != null ? `${log.duration_ms} ms` : '—'}</td>
                <td className="p-3 tabular-nums text-slate-500">{log.attempt}</td>
                <td className="p-3"><OutcomeBadge outcome={log.outcome} /></td>
                <td className="p-3 text-xs text-red-600 max-w-[220px] truncate" title={log.error_message ?? undefined}>{log.error_message ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>

      {nextBefore && (
        <div className="flex justify-center">
          <Button variant="secondary" size="sm" onClick={() => load(nextBefore)} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null} טען עוד
          </Button>
        </div>
      )}

      <p className="text-xs text-slate-400">
        כותרות הרשאה, מפתחות וסודות מוסתרים לפני השמירה. הרשומות נשמרות לתקופה מוגבלת (ברירת מחדל 90 יום).
      </p>

      {openId && (
        <LogDrawer
          id={openId}
          onClose={closeDrawer}
          onFilterCorrelation={(c) => { setOpenId(null); onFiltersChange({ ...filters, correlationId: c }); }}
        />
      )}
    </div>
  );
}
