'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlaskConical, Loader2, RotateCcw, ShieldAlert } from 'lucide-react';
import clsx from 'clsx';
import { useSession } from '@/components/Auth/SessionContext';
import { useToast } from '@/components/ui/Toast';
import { fetchOrgFeatureFlags, setOrgFeatureFlag } from '@/lib/api';
import type { FeatureFlag, FeatureFlagState } from '@/shared/featureFlags';

/** "תכונות ניסיוניות": office owners turn experimental features on/off for their office. */
export default function ExperimentalFeaturesPage() {
  const { me, loading: sessionLoading, currentOrgId } = useSession();
  const { toast } = useToast();

  const ownedOrgs = useMemo(() => (me?.organizations ?? []).filter((o) => o.role === 'owner'), [me]);
  const [orgId, setOrgId] = useState<string | null>(null);
  const [flags, setFlags] = useState<FeatureFlagState[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<FeatureFlag | null>(null);

  useEffect(() => {
    if (orgId || ownedOrgs.length === 0) return;
    setOrgId(ownedOrgs.find((o) => o.id === currentOrgId)?.id ?? ownedOrgs[0].id);
  }, [ownedOrgs, currentOrgId, orgId]);

  const load = useCallback(async (id: string) => {
    setFlags(null); setError(null);
    try {
      setFlags((await fetchOrgFeatureFlags(id)).flags);
    } catch (err) {
      console.error('[settings/experimental] Failed to load flags:', err);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => { if (orgId) load(orgId); }, [orgId, load]);

  const update = async (flag: FeatureFlag, enabled: boolean | null) => {
    if (!orgId) return;
    setSaving(flag);
    try {
      const res = await setOrgFeatureFlag(orgId, flag, enabled);
      setFlags(res.flags);
      const state = res.flags.find((f) => f.flag === flag);
      toast(state?.enabled ? `"${state.label}" הופעלה למשרד` : `"${state?.label ?? flag}" כובתה למשרד`, 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'שגיאה בשמירה', 'error');
    } finally {
      setSaving(null);
    }
  };

  if (sessionLoading) {
    return <div className="flex items-center justify-center py-24 text-slate-400"><Loader2 className="h-7 w-7 animate-spin" /></div>;
  }

  if (me?.mock) {
    return (
      <div className="card p-6 max-w-2xl text-sm text-slate-600 space-y-2">
        <p className="font-semibold text-slate-800">במצב סימולציה מקומי אין הגדרות משרד.</p>
        <p>להפעלת תכונה בפיתוח מקומי הגדירו ב-.env.local למשל <span dir="ltr" className="font-mono">FEATURE_FLAGS_DEFAULT=accountant_review_loop</span>.</p>
      </div>
    );
  }

  if (ownedOrgs.length === 0) {
    return (
      <div className="card p-6 max-w-2xl flex items-start gap-3 text-sm text-slate-600">
        <ShieldAlert className="h-5 w-5 text-amber-500 shrink-0" />
        רק בעלי המשרד יכולים לשנות תכונות ניסיוניות.
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-3xl" style={{ direction: 'rtl' }}>
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
            <FlaskConical className="h-6 w-6 text-blue-600" /> תכונות ניסיוניות
          </h2>
          <p className="text-sm text-slate-500 mt-1">הפעלה וכיבוי של תכונות חדשות עבור המשרד בלבד. השינוי חל על כל המשתמשים במשרד.</p>
        </div>
        {ownedOrgs.length > 1 && (
          <select
            value={orgId ?? ''}
            onChange={(e) => setOrgId(e.target.value)}
            className="text-sm border border-slate-200 rounded-lg bg-white px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 text-right"
          >
            {ownedOrgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        )}
      </div>

      {error && <div className="p-4 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">{error}</div>}

      {!flags && !error ? (
        <div className="flex items-center justify-center py-16 text-slate-400"><Loader2 className="h-6 w-6 animate-spin" /></div>
      ) : (
        <div className="space-y-3">
          {(flags ?? []).map((f) => (
            <div key={f.flag} className="card p-5 flex items-start gap-4">
              <div className="flex-1 min-w-0 space-y-1.5">
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="font-semibold text-slate-900">{f.label}</h3>
                  <span className={clsx(
                    'text-[11px] px-2 py-0.5 rounded-full border font-medium',
                    f.enabled ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-slate-100 text-slate-500 border-slate-200'
                  )}>
                    {f.enabled ? 'פעילה' : 'כבויה'}
                  </span>
                  <span className="text-[11px] text-slate-400">
                    {f.override === null ? `ברירת מחדל (${f.defaultEnabled ? 'פעילה' : 'כבויה'})` : 'הוגדר למשרד'}
                  </span>
                </div>
                <p className="text-sm text-slate-600 leading-relaxed">{f.description}</p>
                {f.override !== null && (
                  <button
                    type="button"
                    onClick={() => update(f.flag, null)}
                    disabled={saving === f.flag}
                    className="inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700 disabled:opacity-50"
                  >
                    <RotateCcw className="h-3 w-3" /> חזרה לברירת המחדל
                  </button>
                )}
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={f.enabled}
                aria-label={f.label}
                onClick={() => update(f.flag, !f.enabled)}
                disabled={saving === f.flag}
                className={clsx(
                  'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-60 mt-1',
                  f.enabled ? 'bg-blue-600' : 'bg-slate-300'
                )}
              >
                <span
                  className={clsx(
                    'inline-block h-5 w-5 rounded-full bg-white shadow transition-transform',
                    f.enabled ? '-translate-x-[22px]' : '-translate-x-0.5'
                  )}
                />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
