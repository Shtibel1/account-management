'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { format } from 'date-fns';
import { CheckCircle2, Clock, Link2, Mail, MessageCircle, Undo2, XCircle } from 'lucide-react';
import { fetchInvoiceNotifications } from '@/lib/api';
import { formatPhoneForDisplay } from '@/lib/phone';
import type { ClientNotification, Invoice } from '@/shared/types';

const STATUS_LABEL: Record<ClientNotification['status'], string> = {
  sent: 'נשלח',
  failed: 'נכשל',
  not_sent: 'לא נשלח',
};

function NotificationRow({ n }: { n: ClientNotification }) {
  const Icon = n.channel === 'email' ? Mail : MessageCircle;
  const StatusIcon = n.status === 'sent' ? CheckCircle2 : n.status === 'failed' ? XCircle : Clock;
  const statusClass = n.status === 'sent' ? 'text-emerald-600' : n.status === 'failed' ? 'text-red-600' : 'text-slate-500';
  const to = n.recipient ? (n.channel === 'whatsapp' ? formatPhoneForDisplay(n.recipient) : n.recipient) : null;
  return (
    <li className="flex items-start gap-2 text-xs">
      <Icon className="h-3.5 w-3.5 text-slate-400 shrink-0 mt-0.5" />
      <div className="min-w-0 flex-1">
        <span className={`inline-flex items-center gap-1 font-medium ${statusClass}`}>
          <StatusIcon className="h-3 w-3" /> {STATUS_LABEL[n.status]}
        </span>
        {to && <span className="text-slate-600 font-mono mr-1.5" dir="ltr">{to}</span>}
        <span className="text-slate-400 mr-1.5 tabular-nums">{format(new Date(n.created_at), 'dd/MM HH:mm')}</span>
        {n.error && <p className="text-slate-500 truncate" title={n.error}>{n.error}</p>}
      </div>
    </li>
  );
}

/**
 * Review-screen banners of the accountant review loop (render only while the flag is on):
 *   - on a returned invoice: reason, when, notification log, link to the corrected document;
 *   - on a corrected document: link back to the invoice it replaces.
 */
export function ReturnedNotice({ invoice }: { invoice: Invoice }) {
  const [notifications, setNotifications] = useState<ClientNotification[] | null>(null);
  const isReturned = invoice.status === 'returned';

  useEffect(() => {
    if (!isReturned) return;
    let cancelled = false;
    fetchInvoiceNotifications(invoice.id)
      .then((rows) => { if (!cancelled) setNotifications(rows); })
      .catch((err) => {
        console.error('[ReturnedNotice] Failed to load notifications:', err);
        if (!cancelled) setNotifications([]);
      });
    return () => { cancelled = true; };
  }, [invoice.id, isReturned, invoice.returned_at]);

  return (
    <>
      {invoice.resubmission_of && (
        <div className="mb-4 flex items-center gap-3 p-3 bg-sky-50 border border-sky-200 rounded-xl text-sm text-sky-800">
          <Link2 className="h-4 w-4 shrink-0 text-sky-500" />
          <span className="flex-1">מסמך מתוקן שהלקוח שלח עבור חשבונית שהוחזרה אליו.</span>
          <Link href={`/review/${invoice.resubmission_of}`} className="text-xs font-semibold text-sky-700 hover:text-sky-900 underline">
            לחשבונית שהוחזרה
          </Link>
        </div>
      )}

      {isReturned && (
        <div className="mb-4 p-3 bg-orange-50 border border-orange-200 rounded-xl text-sm text-orange-900 space-y-2">
          <div className="flex items-start gap-3">
            <Undo2 className="h-4 w-4 mt-0.5 shrink-0 text-orange-500" />
            <div className="flex-1 min-w-0">
              <p className="font-semibold">
                הוחזר ללקוח
                {invoice.returned_at && (
                  <span className="font-normal text-orange-700"> · {format(new Date(invoice.returned_at), 'dd/MM/yyyy HH:mm')}</span>
                )}
              </p>
              {invoice.return_reason && <p className="text-orange-800 whitespace-pre-line">סיבה: {invoice.return_reason}</p>}
            </div>
            {invoice.resubmitted_invoice_id ? (
              <Link
                href={`/review/${invoice.resubmitted_invoice_id}`}
                className="text-xs px-3 py-1.5 rounded-lg bg-orange-600 hover:bg-orange-700 text-white font-semibold transition-colors shrink-0"
              >
                למסמך המתוקן
              </Link>
            ) : (
              <span className="text-xs text-orange-700 shrink-0">ממתין למסמך מתוקן</span>
            )}
          </div>
          {notifications && notifications.length > 0 && (
            <ul className="space-y-1 border-t border-orange-200/70 pt-2 pr-7">
              {notifications.map((n) => <NotificationRow key={n.id} n={n} />)}
            </ul>
          )}
        </div>
      )}
    </>
  );
}
