'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import clsx from 'clsx';
import { Download, Eye, Loader2, Send, Settings } from 'lucide-react';
import type { Invoice } from '@/shared/types';
import type { PluginInfo } from '@/integrations/types';
import type { InvoiceOutcomeStatus } from '@/integrations/exportRunner';
import {
  downloadBase64File,
  fetchClientIntegrations,
  runIntegrationExport,
  type ExportRunResponse,
} from '@/lib/integrationsApi';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { useEscapeKey } from '@/components/ui/useEscapeKey';

const STATUS_STYLES: Record<InvoiceOutcomeStatus, { label: string; className: string }> = {
  success: { label: 'יוצאה', className: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  failed: { label: 'נכשלה', className: 'bg-red-50 text-red-700 border-red-200' },
  skipped: { label: 'דולגה', className: 'bg-slate-100 text-slate-600 border-slate-200' },
  blocked: { label: 'דורשת בדיקה', className: 'bg-amber-50 text-amber-700 border-amber-200' },
  dry_run: { label: 'הדמיה', className: 'bg-blue-50 text-blue-700 border-blue-200' },
};

/** Export the selected invoices (one client) through an export plugin, with a dry-run preview. */
export function IntegrationExportDialog({
  clientId,
  clientName,
  invoices,
  onClose,
  onExported,
}: {
  clientId: string;
  clientName?: string;
  invoices: Invoice[];
  onClose: () => void;
  onExported: () => void;
}) {
  const { toast } = useToast();
  const [plugins, setPlugins] = useState<PluginInfo[] | null>(null);
  const [pluginId, setPluginId] = useState('');
  const [dryRun, setDryRun] = useState(true);
  const [force, setForce] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ExportRunResponse | null>(null);
  const [openPayload, setOpenPayload] = useState<string | null>(null);

  useEffect(() => {
    fetchClientIntegrations(clientId)
      .then((data) => {
        const enabled = new Set(data.integrations.filter((i) => i.enabled).map((i) => i.plugin_id));
        const available = data.plugins.filter((p) =>
          enabled.has(p.id) || (p.kind === 'file' && p.configFields.length === 0 && !data.integrations.some((i) => i.plugin_id === p.id && !i.enabled))
        );
        setPlugins(available);
        const preferred = available.find((p) => p.kind === 'api') ?? available[0];
        setPluginId(preferred?.id ?? '');
      })
      .catch((err) => {
        console.error('[IntegrationExport] Failed to load integrations:', err);
        toast(err instanceof Error ? err.message : 'שגיאה בטעינת החיבורים', 'error');
        setPlugins([]);
      });
  }, [clientId, toast]);

  const fileNames = useMemo(() => new Map(invoices.map((i) => [i.id, i.file_name])), [invoices]);
  const plugin = plugins?.find((p) => p.id === pluginId) ?? null;

  const handleRun = async () => {
    if (!plugin) return;
    setRunning(true);
    setResult(null);
    try {
      const res = await runIntegrationExport({ invoiceIds: invoices.map((i) => i.id), pluginId: plugin.id, dryRun, force });
      setResult(res);
      if (res.file && !res.dryRun) downloadBase64File(res.file);
      if (!res.dryRun && res.summary.success > 0) onExported();
      if (!res.dryRun) {
        toast(
          `יוצאו ${res.summary.success}, נכשלו ${res.summary.failed}, דולגו ${res.summary.skipped + res.summary.blocked}`,
          res.summary.failed + res.summary.blocked > 0 ? 'error' : 'success'
        );
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : 'הייצוא נכשל', 'error');
    } finally {
      setRunning(false);
    }
  };

  useEscapeKey(onClose);

  return (
    <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-50 flex items-center justify-center p-4" style={{ direction: 'rtl' }} onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label="ייצוא להנהלת חשבונות" className="bg-white rounded-2xl border border-slate-100 shadow-xl max-w-3xl w-full max-h-[90vh] overflow-y-auto p-6 space-y-5 text-right" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-slate-100 pb-3">
          <h3 className="text-lg font-bold text-slate-900">
            ייצוא להנהלת חשבונות{clientName ? ` · ${clientName}` : ''} ({invoices.length} חשבוניות)
          </h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 transition-colors text-lg font-bold" aria-label="סגור">✕</button>
        </div>

        {plugins === null ? (
          <div className="flex items-center justify-center py-10 text-slate-400"><Loader2 className="h-6 w-6 animate-spin" /></div>
        ) : plugins.length === 0 ? (
          <p className="text-sm text-slate-500">
            לא הוגדר חיבור ללקוח זה.{' '}
            <Link href={`/integrations?clientId=${encodeURIComponent(clientId)}`} className="text-blue-600 hover:underline">הגדרת חיבור</Link>
          </p>
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-4 items-end">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5" htmlFor="export-plugin">מערכת יעד</label>
                <select id="export-plugin" className="input-base" value={pluginId} onChange={(e) => { setPluginId(e.target.value); setResult(null); }}>
                  {plugins.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}
                </select>
              </div>
              <Link
                href={`/integrations?clientId=${encodeURIComponent(clientId)}`}
                className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-700 pb-2.5"
              >
                <Settings className="h-4 w-4" /> הגדרות חיבור
              </Link>
            </div>

            <div className="flex flex-wrap gap-5 text-sm text-slate-700">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" className="accent-blue-600" checked={dryRun} onChange={(e) => { setDryRun(e.target.checked); setResult(null); }} />
                הדמיה בלבד (בניית הנתונים בלי לשלוח)
              </label>
              <label className="flex items-center gap-2 cursor-pointer" title={plugin?.kind === 'file' ? 'בניית הקובץ מחדש גם עבור חשבוניות שכבר יוצאו (הורדה חוזרת)' : 'שליחה חוזרת של חשבוניות שייצוא קודם שלהן לא הסתיים'}>
                <input type="checkbox" className="accent-amber-600" checked={force} onChange={(e) => setForce(e.target.checked)} />
                {plugin?.kind === 'file' ? 'ייצוא חוזר / הורדה חוזרת של הקובץ' : 'ייצוא חוזר בכל זאת'}
              </label>
            </div>

            <div className="flex items-center gap-2">
              <Button onClick={handleRun} disabled={running || !plugin}>
                {running ? <Loader2 className="h-4 w-4 animate-spin" /> : dryRun ? <Eye className="h-4 w-4" /> : <Send className="h-4 w-4" />}
                {running ? 'מבצע...' : dryRun ? 'הצג מה יישלח' : 'ייצא עכשיו'}
              </Button>
              {result?.file && (
                <Button variant="secondary" onClick={() => downloadBase64File(result.file!)}>
                  <Download className="h-4 w-4" /> הורד <bdi>{result.file.fileName}</bdi>
                </Button>
              )}
              {result && !result.dryRun && plugin?.kind === 'api' && (
                <span className="text-xs text-slate-400">סביבה: {result.environment === 'sandbox' ? 'בדיקות' : 'ייצור'}</span>
              )}
            </div>
          </>
        )}

        {result && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="font-semibold text-slate-800">{result.dryRun ? 'תוצאת ההדמיה' : 'תוצאת הייצוא'}</span>
              <Link
                href={`/integration-logs?clientId=${encodeURIComponent(clientId)}&correlationId=${result.correlationId}`}
                className="text-xs text-blue-600 hover:underline"
              >
                ביומן האינטגרציות
              </Link>
            </div>
            <div className="border border-slate-100 rounded-xl divide-y divide-slate-50">
              {result.results.map((r) => {
                const s = STATUS_STYLES[r.status];
                return (
                  <div key={r.invoiceId} className="px-3 py-2 text-sm">
                    <div className="flex items-center gap-3">
                      <span className={clsx('text-xs border rounded-full px-2 py-0.5 shrink-0', s.className)}>{s.label}</span>
                      <span className="text-slate-700 truncate flex-1" title={fileNames.get(r.invoiceId)}>{fileNames.get(r.invoiceId) ?? r.invoiceId}</span>
                      {r.externalId && (
                        r.url
                          ? <a href={r.url} target="_blank" rel="noreferrer noopener" className="font-mono text-xs text-blue-600 hover:underline" dir="ltr">{r.externalId}</a>
                          : <span className="font-mono text-xs text-slate-500 truncate max-w-[200px]" dir="ltr">{r.externalId}</span>
                      )}
                      {r.payload !== undefined && (
                        <button type="button" className="text-xs text-blue-600 hover:underline shrink-0" onClick={() => setOpenPayload(openPayload === r.invoiceId ? null : r.invoiceId)}>
                          {openPayload === r.invoiceId ? 'הסתר' : 'נתונים'}
                        </button>
                      )}
                    </div>
                    {r.message && <p className="text-xs text-slate-500 mt-1">{r.message}</p>}
                    {openPayload === r.invoiceId && (
                      <pre dir="ltr" className="mt-2 bg-slate-900 text-slate-100 text-xs rounded-lg p-3 overflow-x-auto max-h-72 text-left">
                        {JSON.stringify(r.payload, null, 2)}
                      </pre>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
