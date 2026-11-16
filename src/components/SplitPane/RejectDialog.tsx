'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2, XCircle } from 'lucide-react';
import { useEscapeKey } from '@/components/ui/useEscapeKey';

/** Matches the reject route / invoices.reject_reason limit. */
export const REJECT_REASON_MAX_LENGTH = 500;

/**
 * Confirmation for "לא מאושר": rejecting is one tap away from "אשר חשבונית", so it asks first and
 * takes an optional reason (kept on the invoice and in its status log).
 */
export function RejectDialog({
  fileName,
  busy,
  onConfirm,
  onClose,
}: {
  fileName: string;
  busy: boolean;
  onConfirm: (reason: string) => void;
  onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const cancelRef = useRef<HTMLButtonElement>(null);
  const tooLong = reason.trim().length > REJECT_REASON_MAX_LENGTH;

  // Focus "cancel" first: a second accidental tap must not reject
  useEffect(() => { cancelRef.current?.focus(); }, []);
  useEscapeKey(() => { if (!busy) onClose(); });

  return (
    <div
      className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-50 flex items-center justify-center p-4"
      style={{ direction: 'rtl' }}
      onClick={() => { if (!busy) onClose(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="reject-dialog-title"
        className="bg-white rounded-2xl border border-slate-100 shadow-xl max-w-md w-full p-6 space-y-4 text-right max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="reject-dialog-title" className="text-lg font-bold text-slate-900 flex items-center gap-2">
          <XCircle className="h-5 w-5 text-rose-600" /> לסמן את החשבונית כלא מאושרת?
        </h3>
        <p className="text-sm text-slate-500">
          המסמך <bdi className="font-semibold text-slate-700">{fileName}</bdi> לא ייוצא להנהלת החשבונות ולא ייחשב
          בבדיקת כפילויות. ניתן לפתוח אותו מחדש לבדיקה בהמשך.
        </p>
        <div className="space-y-1.5">
          <label htmlFor="reject-reason" className="block text-sm font-medium text-slate-700">
            סיבה <span className="font-normal text-slate-400">(לא חובה)</span>
          </label>
          <textarea
            id="reject-reason"
            className="input-base min-h-[80px]"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="למשל: לא חשבונית מס, מסמך כפול, הוצאה פרטית"
            maxLength={REJECT_REASON_MAX_LENGTH + 50}
            aria-invalid={tooLong}
            aria-describedby="reject-reason-hint"
            disabled={busy}
          />
          <p id="reject-reason-hint" className={tooLong ? 'text-xs text-red-600' : 'text-xs text-slate-400'}>
            {reason.trim().length}/{REJECT_REASON_MAX_LENGTH} תווים
          </p>
        </div>
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
            onClick={() => onConfirm(reason.trim())}
            disabled={busy || tooLong}
            className="flex-1 py-2.5 bg-rose-600 hover:bg-rose-700 text-white font-semibold text-sm rounded-xl transition-colors disabled:opacity-60 flex items-center justify-center gap-2"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {busy ? 'מסמן...' : 'סמן כלא מאושרת'}
          </button>
        </div>
      </div>
    </div>
  );
}
