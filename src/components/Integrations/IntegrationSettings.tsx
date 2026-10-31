'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import clsx from 'clsx';
import {
  AlertTriangle, CheckCircle2, FileText, Loader2, Plug, PlugZap, ScrollText, Trash2, XCircle,
} from 'lucide-react';
import type { ClientIntegrationView, ConfigField, IntegrationEnvironment, PluginInfo } from '@/integrations/types';
import {
  ApiError,
  deleteClientIntegration,
  fetchClientIntegrations,
  saveClientIntegration,
  testClientIntegration,
  type TestConnectionResponse,
} from '@/lib/integrationsApi';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { useConfirm } from '@/components/ui/ConfirmDialog';

const CAPABILITY_LABELS: Record<keyof PluginInfo['capabilities'], string> = {
  attachPdf: 'צירוף PDF',
  allocationNumber: 'מספר הקצאה',
  duplicateCheck: 'בדיקת כפילויות',
  sandbox: 'סביבת בדיקות',
};

function statusOf(plugin: PluginInfo, integration: ClientIntegrationView | undefined) {
  if (!integration) {
    return plugin.kind === 'file' && plugin.configFields.length === 0
      ? { label: 'זמין', className: 'bg-slate-100 text-slate-600 border-slate-200' }
      : { label: 'לא הוגדר', className: 'bg-slate-100 text-slate-500 border-slate-200' };
  }
  if (!integration.enabled) return { label: 'מושבת', className: 'bg-amber-50 text-amber-700 border-amber-200' };
  return { label: 'פעיל', className: 'bg-emerald-50 text-emerald-700 border-emerald-200' };
}

/** Form state: non-secret values as typed; secrets only hold NEW values ('' = keep stored). */
type FormValues = Record<string, string>;

function initialValues(plugin: PluginInfo, integration: ClientIntegrationView | undefined): FormValues {
  const out: FormValues = {};
  for (const f of plugin.configFields) {
    const stored = integration?.config_masked?.[f.key];
    out[f.key] = f.secret ? '' : stored === undefined || stored === null ? '' : String(stored);
  }
  return out;
}

function PluginForm({
  clientId,
  plugin,
  integration,
  encryptionConfigured,
  onSaved,
  onDeleted,
}: {
  clientId: string;
  plugin: PluginInfo;
  integration: ClientIntegrationView | undefined;
  encryptionConfigured: boolean;
  onSaved: (view: ClientIntegrationView) => void;
  onDeleted: () => void;
}) {
  const { toast } = useToast();
  const askConfirm = useConfirm();
  const [values, setValues] = useState<FormValues>(() => initialValues(plugin, integration));
  const [cleared, setCleared] = useState<Set<string>>(new Set());
  const [enabled, setEnabled] = useState(integration?.enabled ?? true);
  const [environment, setEnvironment] = useState<IntegrationEnvironment>(
    integration?.environment ?? (plugin.capabilities.sandbox ? 'sandbox' : 'production')
  );
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [issues, setIssues] = useState<string[]>([]);
  const [testResult, setTestResult] = useState<TestConnectionResponse | null>(null);

  useEffect(() => {
    setValues(initialValues(plugin, integration));
    setCleared(new Set());
    setEnabled(integration?.enabled ?? true);
    setEnvironment(integration?.environment ?? (plugin.capabilities.sandbox ? 'sandbox' : 'production'));
    setIssues([]);
    setTestResult(null);
  }, [plugin, integration]);

  const configPayload = (): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const f of plugin.configFields) {
      if (f.secret) {
        if (cleared.has(f.key)) out[f.key] = null;
        else if (values[f.key]) out[f.key] = values[f.key];
      } else {
        out[f.key] = values[f.key] ?? '';
      }
    }
    return out;
  };

  const handleSave = async () => {
    setSaving(true);
    setIssues([]);
    try {
      const view = await saveClientIntegration(clientId, plugin.id, { enabled, environment, config: configPayload() });
      onSaved(view);
      toast('ההגדרות נשמרו', 'success');
    } catch (err) {
      if (err instanceof ApiError && err.issues.length) setIssues(err.issues);
      toast(err instanceof Error ? err.message : 'שמירת ההגדרות נכשלה', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testClientIntegration(clientId, plugin.id, { environment, config: configPayload() });
      setTestResult(result);
      if (result.issues?.length) setIssues(result.issues);
    } finally {
      setTesting(false);
    }
  };

  const handleDelete = async () => {
    if (!(await askConfirm({ title: 'הסרת חיבור', message: `להסיר את החיבור ל-${plugin.displayName}? ההגדרות והסודות השמורים יימחקו.`, confirmLabel: 'הסר חיבור', tone: 'danger' }))) return;
    setDeleting(true);
    try {
      await deleteClientIntegration(clientId, plugin.id);
      onDeleted();
      toast('החיבור הוסר', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'מחיקת החיבור נכשלה', 'error');
    } finally {
      setDeleting(false);
    }
  };

  const renderField = (f: ConfigField) => {
    const masked = integration?.config_masked?.[f.key];
    const hasStoredSecret = f.secret && typeof masked === 'string' && masked !== '' && !cleared.has(f.key);
    return (
      <div key={f.key}>
        <label className="block text-sm font-medium text-slate-700 mb-1.5" htmlFor={`cfg-${f.key}`}>
          {f.label}{f.required && ' *'}
        </label>
        {f.type === 'select' ? (
          <select
            id={`cfg-${f.key}`} className="input-base"
            value={values[f.key] ?? ''} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
          >
            <option value="">בחרו...</option>
            {f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        ) : (
          <div className="flex items-center gap-2">
            <input
              id={`cfg-${f.key}`}
              type={f.secret ? 'password' : f.type === 'number' ? 'number' : 'text'}
              autoComplete={f.secret ? 'new-password' : 'off'}
              dir={f.type === 'url' || f.secret ? 'ltr' : undefined}
              className={clsx('input-base', (f.type === 'url' || f.secret) && 'text-left font-mono')}
              placeholder={hasStoredSecret ? `${masked} (שמור - הקלידו כדי להחליף)` : f.placeholder}
              value={values[f.key] ?? ''}
              onChange={(e) => {
                setValues({ ...values, [f.key]: e.target.value });
                if (cleared.has(f.key)) setCleared(new Set([...cleared].filter((k) => k !== f.key)));
              }}
            />
            {hasStoredSecret && (
              <button
                type="button" title="מחק את הערך השמור"
                onClick={() => { setCleared(new Set([...cleared, f.key])); setValues({ ...values, [f.key]: '' }); }}
                className="text-xs text-slate-500 hover:text-red-600 whitespace-nowrap"
              >
                נקה
              </button>
            )}
          </div>
        )}
        {cleared.has(f.key) && <p className="text-xs text-amber-600 mt-1">הערך השמור יימחק בשמירה.</p>}
        {f.help && <p className="text-xs text-slate-400 mt-1">{f.help}</p>}
      </div>
    );
  };

  const needsConfig = plugin.configFields.length > 0;

  return (
    <div className="card p-6 space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-lg font-bold text-slate-900">{plugin.displayName}</h3>
          <p className="text-sm text-slate-500 mt-1">{plugin.description}</p>
          <div className="flex flex-wrap gap-1.5 mt-3">
            <span className="text-xs bg-blue-50 text-blue-700 border border-blue-100 rounded-full px-2.5 py-0.5">
              {plugin.kind === 'api' ? 'חיבור API' : 'ייצוא לקובץ'}
            </span>
            {(Object.keys(CAPABILITY_LABELS) as (keyof PluginInfo['capabilities'])[])
              .filter((k) => plugin.capabilities[k])
              .map((k) => (
                <span key={k} className="text-xs bg-slate-100 text-slate-600 rounded-full px-2.5 py-0.5">{CAPABILITY_LABELS[k]}</span>
              ))}
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-700 shrink-0 cursor-pointer min-h-[44px] px-2 -mx-2 rounded-lg hover:bg-slate-50">
          <input type="checkbox" className="accent-blue-600 h-5 w-5" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          פעיל
        </label>
      </div>

      {needsConfig && !encryptionConfigured && (
        <div className="flex items-start gap-2 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <span>
            הצפנת ההגדרות אינה מוגדרת בשרת (<code dir="ltr" className="font-mono text-xs">INTEGRATIONS_ENCRYPTION_KEY</code>), לכן לא ניתן לשמור פרטי גישה.
          </span>
        </div>
      )}

      {plugin.capabilities.sandbox && (
        <div>
          <p className="text-sm font-medium text-slate-700 mb-1.5">סביבה</p>
          <div className="inline-flex rounded-xl border border-slate-200 p-1 bg-slate-50">
            {(['sandbox', 'production'] as const).map((env) => (
              <button
                key={env} type="button" onClick={() => setEnvironment(env)}
                className={clsx(
                  'px-4 py-1.5 text-sm rounded-lg font-medium transition-colors',
                  environment === env ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500 hover:text-slate-700'
                )}
              >
                {env === 'sandbox' ? 'בדיקות (Sandbox)' : 'ייצור (Production)'}
              </button>
            ))}
          </div>
          {environment === 'production' && (
            <p className="text-xs text-amber-600 mt-1.5">בסביבת ייצור המסמכים נרשמים בפועל בהנהלת החשבונות של הלקוח.</p>
          )}
        </div>
      )}

      {needsConfig ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">{plugin.configFields.map(renderField)}</div>
      ) : (
        <p className="text-sm text-slate-500 flex items-center gap-2">
          <FileText className="h-4 w-4 text-slate-400" /> אין צורך בהגדרות - הקובץ יורד מהמסך &quot;בדיקה ואישור&quot;.
        </p>
      )}

      {issues.length > 0 && (
        <ul className="text-sm text-red-600 list-disc list-inside space-y-0.5">
          {issues.map((i) => <li key={i}>{i}</li>)}
        </ul>
      )}

      {testResult && (
        <div
          className={clsx(
            'flex items-start gap-2 text-sm rounded-xl px-4 py-3 border',
            testResult.ok ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-red-50 border-red-200 text-red-800'
          )}
        >
          {testResult.ok ? <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" /> : <XCircle className="h-4 w-4 mt-0.5 shrink-0" />}
          <span className="flex-1">{testResult.message}</span>
          {testResult.correlationId && (
            <Link
              href={`/integration-logs?clientId=${encodeURIComponent(clientId)}&correlationId=${testResult.correlationId}`}
              className="text-xs underline underline-offset-2 whitespace-nowrap"
            >
              ביומן
            </Link>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-slate-100">
        <Button onClick={handleSave} disabled={saving || (needsConfig && !encryptionConfigured)} className="mt-4">
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {saving ? 'שומר...' : 'שמור הגדרות'}
        </Button>
        <Button variant="secondary" onClick={handleTest} disabled={testing} className="mt-4">
          {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlugZap className="h-4 w-4" />}
          בדוק חיבור
        </Button>
        <div className="flex-1" />
        {integration && (
          <Button variant="ghost" onClick={handleDelete} disabled={deleting} className="mt-4 text-red-600 hover:bg-red-50">
            {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
            הסר חיבור
          </Button>
        )}
      </div>
    </div>
  );
}

/** "חיבור להנהלת חשבונות" for one client: plugin list + config form. */
export function IntegrationSettings({ clientId }: { clientId: string }) {
  const { toast } = useToast();
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [integrations, setIntegrations] = useState<ClientIntegrationView[]>([]);
  const [encryptionConfigured, setEncryptionConfigured] = useState(true);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchClientIntegrations(clientId);
      setPlugins(data.plugins);
      setIntegrations(data.integrations);
      setEncryptionConfigured(data.encryptionConfigured);
      setSelectedId((prev) => prev ?? data.integrations[0]?.plugin_id ?? data.plugins[0]?.id ?? null);
    } catch (err) {
      console.error('[Integrations] Failed to load settings:', err);
      toast(err instanceof Error ? err.message : 'שגיאה בטעינת הגדרות החיבור', 'error');
    } finally {
      setLoading(false);
    }
  }, [clientId, toast]);

  useEffect(() => { setSelectedId(null); load(); }, [load]);

  const byPlugin = useMemo(() => new Map(integrations.map((i) => [i.plugin_id, i])), [integrations]);
  const selected = plugins.find((p) => p.id === selectedId) ?? null;

  if (loading && plugins.length === 0) {
    return (
      <div className="card flex items-center justify-center py-24 text-slate-400">
        <Loader2 className="h-7 w-7 animate-spin" />
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[18rem_1fr] gap-5 items-start">
      <div className="card p-2 space-y-1">
        {plugins.map((p) => {
          const status = statusOf(p, byPlugin.get(p.id));
          return (
            <button
              key={p.id} type="button" onClick={() => setSelectedId(p.id)}
              className={clsx(
                'w-full flex items-center gap-3 px-3 py-3 rounded-xl text-right transition-colors',
                selectedId === p.id ? 'bg-blue-50 ring-1 ring-blue-200' : 'hover:bg-slate-50'
              )}
            >
              <div className={clsx('rounded-lg p-2', p.kind === 'api' ? 'bg-blue-600' : 'bg-slate-500')}>
                {p.kind === 'api' ? <Plug className="h-4 w-4 text-white" /> : <FileText className="h-4 w-4 text-white" />}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-slate-800 truncate">{p.displayName}</p>
                <p className="text-xs text-slate-400">{p.kind === 'api' ? 'API' : 'קובץ'}</p>
              </div>
              <span className={clsx('text-xs border rounded-full px-2 py-0.5 shrink-0', status.className)}>{status.label}</span>
            </button>
          );
        })}
        <Link
          href={`/integration-logs?clientId=${encodeURIComponent(clientId)}`}
          className="flex items-center gap-2 px-3 py-2.5 text-sm text-blue-600 hover:text-blue-700 font-medium"
        >
          <ScrollText className="h-4 w-4" /> יומן אינטגרציות
        </Link>
      </div>

      {selected ? (
        <PluginForm
          clientId={clientId}
          plugin={selected}
          integration={byPlugin.get(selected.id)}
          encryptionConfigured={encryptionConfigured}
          onSaved={(view) => setIntegrations((prev) => [...prev.filter((i) => i.plugin_id !== view.plugin_id), view])}
          onDeleted={() => setIntegrations((prev) => prev.filter((i) => i.plugin_id !== selected.id))}
        />
      ) : (
        <div className="card p-10 text-center text-slate-500 text-sm">בחרו מערכת מהרשימה</div>
      )}
    </div>
  );
}
