import type { InvoiceStatus } from '@/shared/types';

// Invoice status state machine: the single source of truth for which status changes are legal and
// which code path may make them. Mirrored in the DB by the invoices_status_check constraint and the
// invoices_status_guard trigger (supabase/migrations/20261030160000_qa_status_integrity.sql).
//
//   processing → review | approved (supplier auto-approve) | error          (pipeline)
//   review     → approved (approve) | rejected (reject) | returned (return)
//                processing (split) | error (pipeline)
//   approved   → exported (export) | returned (return) | review (reopen)
//   rejected   → returned (return) | review (reopen)
//   error      → processing (retry) | rejected (reject) | returned (return)
//   returned   → review (reopen)
//   exported   → review (reopen, office owner only, logged) - otherwise final

export const INVOICE_STATUSES = [
  'processing',
  'review',
  'approved',
  'exported',
  'error',
  'rejected',
  'returned',
] as const satisfies readonly InvoiceStatus[];

/** The code path that performs a transition. */
export type TransitionVia = 'pipeline' | 'approve' | 'reject' | 'return' | 'export' | 'retry' | 'reopen' | 'split';

export const INVOICE_TRANSITIONS: Readonly<Record<InvoiceStatus, Partial<Record<InvoiceStatus, readonly TransitionVia[]>>>> = {
  processing: { review: ['pipeline'], approved: ['pipeline'], error: ['pipeline'] },
  review: { approved: ['approve'], rejected: ['reject'], returned: ['return'], processing: ['split'], error: ['pipeline'] },
  approved: { exported: ['export'], returned: ['return'], review: ['reopen'] },
  rejected: { returned: ['return'], review: ['reopen'] },
  error: { processing: ['retry'], rejected: ['reject'], returned: ['return'] },
  returned: { review: ['reopen'] },
  exported: { review: ['reopen'] },
};

export function isInvoiceStatus(value: unknown): value is InvoiceStatus {
  return typeof value === 'string' && (INVOICE_STATUSES as readonly string[]).includes(value);
}

/** True when `from → to` is a legal transition (optionally: made by `via`). */
export function canTransition(from: unknown, to: unknown, via?: TransitionVia): boolean {
  if (!isInvoiceStatus(from) || !isInvoiceStatus(to) || from === to) return false;
  const vias = INVOICE_TRANSITIONS[from][to];
  if (!vias) return false;
  return via ? vias.includes(via) : true;
}

/** Statuses a transition to `to` made by `via` may start from (for conditional `.in('status', …)` updates). */
export function sourceStatuses(to: InvoiceStatus, via: TransitionVia): InvoiceStatus[] {
  return INVOICE_STATUSES.filter((from) => canTransition(from, to, via));
}

/** Only invoices waiting in the review queue can be approved by a person. */
export const APPROVABLE_STATUSES: readonly InvoiceStatus[] = sourceStatuses('approved', 'approve');
export const REJECTABLE_STATUSES: readonly InvoiceStatus[] = sourceStatuses('rejected', 'reject');
export const RETRYABLE_STATUSES: readonly InvoiceStatus[] = sourceStatuses('processing', 'retry');
export const REOPENABLE_STATUSES: readonly InvoiceStatus[] = sourceStatuses('review', 'reopen');
/** Failed documents may be deleted outright (nothing was posted or reviewed). */
export const DELETABLE_STATUSES: readonly InvoiceStatus[] = ['error'];

/** Reopening an exported invoice can post it to the books twice: office owner only. */
export function reopenRequiresOwner(status: unknown): boolean {
  return status === 'exported';
}

export const STATUS_LABELS: Readonly<Record<InvoiceStatus, string>> = {
  processing: 'בעיבוד',
  review: 'ממתינה לבדיקה',
  approved: 'מאושרת',
  exported: 'יוצאה',
  error: 'שגיאה',
  rejected: 'לא מאושרת',
  returned: 'הוחזרה ללקוח',
};

/** Hebrew explanation for a refused transition (409). */
export function transitionRefusedMessage(action: 'approve' | 'reject' | 'retry' | 'reopen' | 'delete', status: unknown): string {
  const label = isInvoiceStatus(status) ? STATUS_LABELS[status] : 'לא ידוע';
  if (action === 'approve') {
    if (status === 'exported') return 'החשבונית כבר יוצאה להנהלת החשבונות ולא ניתן לאשר אותה שוב';
    if (status === 'approved') return 'החשבונית כבר אושרה';
    if (status === 'processing') return 'החשבונית עדיין בעיבוד - יש להמתין לסיום העיבוד';
    if (status === 'error') return 'עיבוד החשבונית נכשל - יש לעבד אותה מחדש לפני אישור';
  }
  const verb = { approve: 'לאשר', reject: 'לסמן כלא מאושרת', retry: 'לעבד מחדש', reopen: 'לפתוח מחדש', delete: 'למחוק' }[action];
  return `לא ניתן ${verb} חשבונית בסטטוס "${label}"`;
}
