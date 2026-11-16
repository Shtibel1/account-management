'use client';

import { useEffect, useState } from 'react';
import { BellRing, Loader2 } from 'lucide-react';
import { fetchClientContactEmail, saveClientContactEmail } from '@/lib/api';
import { useFeatureFlag } from '@/components/FeatureFlags/useFeatureFlags';
import { useToast } from '@/components/ui/Toast';
import { normalizeEmail } from '@/shared/authModel';

/**
 * Client email for "returned to client" notifications (clients.contact_email). Renders nothing
 * unless the accountant_review_loop flag is on for the client's office.
 */
export function ClientNotifyEmailSection({ clientId }: { clientId: string }) {
  const enabled = useFeatureFlag('accountant_review_loop', { clientId });
  const { toast } = useToast();
  const [saved, setSaved] = useState<string | null>(null);
  const [value, setValue] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setLoading(true);
    fetchClientContactEmail(clientId)
      .then((res) => {
        if (cancelled) return;
        setSaved(res.contactEmail);
        setValue(res.contactEmail ?? '');
      })
      .catch((err) => console.error('[ClientNotifyEmail] Failed to load contact email:', err))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [clientId, enabled]);

  if (!enabled) return null;

  const trimmed = value.trim();
  const valid = trimmed === '' || normalizeEmail(trimmed) !== null;
  const dirty = (trimmed.toLowerCase() || null) !== saved;

  const save = async () => {
    if (!valid || !dirty || saving) return;
    setSaving(true);
    try {
      const res = await saveClientContactEmail(clientId, trimmed || null);
      setSaved(res.contactEmail);
      setValue(res.contactEmail ?? '');
      toast(res.contactEmail ? 'כתובת העדכונים נשמרה' : 'כתובת העדכונים הוסרה', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'שגיאה בשמירה', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="space-y-2">
      <h4 className="text-sm font-semibold text-slate-800 flex items-center gap-2">
        <BellRing className="h-4 w-4 text-orange-600" /> עדכונים ללקוח
      </h4>
      <p className="text-xs text-slate-500">
        כשמסמך מוחזר ללקוח, ההודעה נשלחת לאימייל הזה ולמספרי הוואטסאפ של הלקוח.
      </p>
      <div className="flex gap-2">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') save(); }}
          placeholder="client@example.com"
          dir="ltr"
          disabled={loading}
          className="input-base text-left flex-1"
        />
        <button
          onClick={save}
          disabled={!valid || !dirty || saving || loading}
          className="flex items-center gap-1 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-3 py-2 rounded-xl text-sm font-semibold transition-colors"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null} שמור
        </button>
      </div>
      {!valid && <p className="text-xs text-red-500">כתובת אימייל לא תקינה</p>}
    </section>
  );
}
