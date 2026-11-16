'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowLeftRight, Loader2 } from 'lucide-react';
import { createClient } from '@/utils/supabase/client';
import { useEscapeKey } from '@/components/ui/useEscapeKey';
import { clientDisplayNames } from '@/shared/clientLabels';
import { moveInvoiceToClient } from '@/lib/api';

/** Statuses from which an invoice can't be moved to another client (exported: server 409; processing: its job reads the old files). */
export const MOVE_BLOCKED_STATUSES = ['exported', 'processing'] as const;

export function moveBlockedReason(status: string): string | null {
  if (status === 'exported') return 'החשבונית כבר יוצאה להנהלת החשבונות ולא ניתן להעביר אותה';
  if (status === 'processing') return 'החשבונית בעיבוד - יש להמתין לסיומו';
  return null;
}

/**
 * "העבר ללקוח": picks another client of the same office and moves the invoice there (PATCH
 * client_id; the server moves the stored files along). In-app dialog, not a native confirm.
 * With several invoices (bulk), each is moved on its own and partial failures are reported.
 */
export function MoveToClientDialog({
  invoiceIds,
  currentClientId,
  label,
  onClose,
  onMoved,
}: {
  invoiceIds: string[];
  /** The invoices' client (excluded from the list), or null when they come from several clients. */
  currentClientId: string | null;
  /** File name (one invoice) or "N חשבוניות". */
  label: string;
  onClose: () => void;
  onMoved: (result: { moved: string[]; failed: { id: string; error: string }[]; targetClientId: string }) => void;
}) {
  const supabase = createClient();
  const [clients, setClients] = useState<{ id: string; label: string }[] | null>(null);
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => { cancelRef.current?.focus(); }, []);
  useEscapeKey(() => { if (!busy) onClose(); });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error: loadErr } = await supabase.from('clients').select('id, name, vat_account, created_at, org_id, archived_at');
      if (cancelled) return;
      if (loadErr || !data) {
        setError('טעינת רשימת הלקוחות נכשלה');
        setClients([]);
        return;
      }
      const rows = data as { id: string; name: string; vat_account?: string | null; created_at?: string | null; org_id?: string | null; archived_at?: string | null }[];
      // Only clients of the same office as the invoice
      const orgId = rows.find((c) => c.id === currentClientId)?.org_id ?? null;
      const sameOffice = rows.filter((c) => c.id !== currentClientId && !c.archived_at && (!orgId || c.org_id === orgId));
      const names = clientDisplayNames(sameOffice);
      setClients(
        sameOffice
          .map((c) => ({ id: c.id, label: names.get(c.id) ?? c.name }))
          .sort((a, b) => a.label.localeCompare(b.label, 'he'))
      );
    })();
    return () => { cancelled = true; };
  }, [currentClientId]);

  const submit = async () => {
    if (!target) return;
    setBusy(true);
    setError('');
    const moved: string[] = [];
    const failed: { id: string; error: string }[] = [];
    for (const id of invoiceIds) {
      try {
        await moveInvoiceToClient(id, target);
        moved.push(id);
      } catch (e) {
        failed.push({ id, error: e instanceof Error ? e.message : 'העברת החשבונית נכשלה' });
      }
    }
    setBusy(false);
    if (failed.length > 0 && moved.length === 0) {
      setError(failed[0].error);
      return;
    }
    onMoved({ moved, failed, targetClientId: target });
  };

  return (
    <div
      className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-50 flex items-center justify-center p-4"
      style={{ direction: 'rtl' }}
      onClick={() => { if (!busy) onClose(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="move-client-title"
        className="bg-white rounded-2xl border border-slate-100 shadow-xl max-w-md w-full p-6 space-y-4 text-right max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="move-client-title" className="text-lg font-bold text-slate-900 flex items-center gap-2">
          <ArrowLeftRight className="h-5 w-5 text-blue-600" /> העברה ללקוח אחר
        </h3>
        <p className="text-sm text-slate-500">
          <bdi className="font-semibold text-slate-700">{label}</bdi> יועבר ללקוח שתבחר, יחד עם קובץ המסמך.
        </p>
        <div className="space-y-1.5">
          <label htmlFor="move-client-select" className="block text-sm font-medium text-slate-700">לקוח יעד</label>
          {clients === null ? (
            <div className="flex items-center gap-2 text-sm text-slate-400"><Loader2 className="h-4 w-4 animate-spin" /> טוען לקוחות...</div>
          ) : clients.length === 0 ? (
            <p className="text-sm text-slate-500">אין לקוחות אחרים במשרד</p>
          ) : (
            <select
              id="move-client-select"
              className="input-base"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              disabled={busy}
            >
              <option value="">בחר לקוח...</option>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          )}
        </div>
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        <div className="flex gap-3 pt-1">
          <button
            ref={cancelRef}
            type="button"
            onClick={onClose}
            disabled={busy}
            className="flex-1 py-2.5 bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 font-semibold text-sm rounded-xl transition-colors disabled:opacity-60"
          >
            ביטול
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={busy || !target}
            className="flex-1 py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-semibold text-sm rounded-xl transition-colors disabled:opacity-60 flex items-center justify-center gap-2"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {busy ? 'מעביר...' : 'העבר'}
          </button>
        </div>
      </div>
    </div>
  );
}
