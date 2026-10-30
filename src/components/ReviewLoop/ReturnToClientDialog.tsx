'use client';

import { useState } from 'react';
import { Loader2, Undo2 } from 'lucide-react';
import clsx from 'clsx';
import { returnInvoiceToClient } from '@/lib/api';
import { useToast } from '@/components/ui/Toast';
import {
  RETURN_NOTE_MAX_LENGTH,
  RETURN_REASONS,
  validateReturnReason,
  type NotificationOutcome,
  type ReturnReasonCode,
} from '@/shared/returns';

const CHANNEL_LABEL: Record<NotificationOutcome['channel'], string> = { email: 'מייל', whatsapp: 'וואטסאפ' };

/** Summary toast text: which channels got the message. */
function notificationSummary(outcomes: NotificationOutcome[]): { text: string; ok: boolean } {
  const sent = outcomes.filter((o) => o.status === 'sent');
  if (sent.length === 0) return { text: 'החשבונית הוחזרה ללקוח, אך לא נשלחה הודעה (ראו פירוט בחשבונית)', ok: false };
  const channels = [...new Set(sent.map((o) => CHANNEL_LABEL[o.channel]))].join(' ו');
  return { text: `החשבונית הוחזרה ללקוח והודעה נשלחה ב${channels}`, ok: true };
}

/** "החזר ללקוח": pick a preset reason (+ free text), confirm, and the client is notified. */
export function ReturnToClientDialog({
  invoiceId,
  fileName,
  onClose,
  onReturned,
}: {
  invoiceId: string;
  fileName: string;
  onClose: () => void;
  onReturned: () => void;
}) {
  const { toast } = useToast();
  const [code, setCode] = useState<ReturnReasonCode | null>(null);
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const validation = validateReturnReason({ code, note });

  const submit = async () => {
    if (!validation.ok || !code || sending) {
      if (!validation.ok) setError(validation.error);
      return;
    }
    setSending(true); setError(null);
    try {
      const res = await returnInvoiceToClient(invoiceId, code, note);
      const summary = notificationSummary(res.notifications);
      toast(summary.text, summary.ok ? 'success' : 'info');
      onReturned();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'שגיאה בהחזרת החשבונית');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-50 flex items-center justify-center p-4" style={{ direction: 'rtl' }} onClick={onClose}>
      <div className="bg-white rounded-2xl border border-slate-100 shadow-xl max-w-md w-full p-6 space-y-4 text-right" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-slate-100 pb-3">
          <h3 className="text-lg font-bold text-slate-900 flex items-center gap-2">
            <Undo2 className="h-5 w-5 text-orange-600" /> החזר ללקוח
          </h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 transition-colors text-lg font-bold">✕</button>
        </div>

        <p className="text-sm text-slate-500">
          המסמך <span className="font-semibold text-slate-700">{fileName}</span> יסומן &quot;הוחזר ללקוח&quot;, והלקוח יקבל הודעה עם הסיבה ובקשה לשלוח מסמך מתוקן.
        </p>

        <div className="space-y-2">
          <p className="text-xs font-semibold text-slate-600">סיבת ההחזרה <span className="text-red-500">*</span></p>
          <div className="flex flex-wrap gap-2">
            {RETURN_REASONS.map((r) => (
              <button
                key={r.code}
                type="button"
                onClick={() => { setCode(r.code); setError(null); }}
                className={clsx(
                  'px-3 py-1.5 rounded-full text-sm border transition-colors',
                  code === r.code
                    ? 'bg-orange-600 border-orange-600 text-white'
                    : 'bg-white border-slate-200 text-slate-700 hover:border-orange-300 hover:bg-orange-50'
                )}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-semibold text-slate-600">
            {code === 'other' ? <>פירוט הסיבה <span className="text-red-500">*</span></> : 'הערה ללקוח (רשות)'}
          </label>
          <textarea
            value={note}
            onChange={(e) => { setNote(e.target.value); setError(null); }}
            maxLength={RETURN_NOTE_MAX_LENGTH}
            rows={3}
            placeholder={code === 'other' ? 'מה צריך לתקן?' : 'למשל: נא לצלם את כל העמוד באור טוב'}
            className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-orange-500/20 focus:border-orange-500 resize-none"
          />
          <p className="text-[11px] text-slate-400 text-left" dir="ltr">{note.length}/{RETURN_NOTE_MAX_LENGTH}</p>
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <div className="flex items-center gap-3 pt-3 border-t border-slate-100 justify-end">
          <button
            onClick={onClose}
            disabled={sending}
            className="px-4 py-2 border border-slate-200 hover:bg-slate-50 text-slate-500 text-sm font-semibold rounded-xl transition-colors disabled:opacity-50"
          >
            ביטול
          </button>
          <button
            onClick={submit}
            disabled={sending || !validation.ok}
            className="px-5 py-2 bg-orange-600 hover:bg-orange-700 text-white text-sm font-semibold rounded-xl shadow-sm transition-colors disabled:opacity-60 flex items-center gap-2"
          >
            {sending ? <><Loader2 className="h-4 w-4 animate-spin" /> שולח...</> : 'החזר ושלח ללקוח'}
          </button>
        </div>
      </div>
    </div>
  );
}
