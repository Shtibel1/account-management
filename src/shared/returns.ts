import type { ExtractedData, InvoiceStatus } from '@/shared/types';
import { normalizeInvoiceNumber, normalizeVatId } from '@/shared/duplicates';

/**
 * Accountant review loop ("החזר ללקוח", feature flag accountant_review_loop) - pure rules:
 * return reasons, which statuses can be returned, notification channel selection, the message
 * text, and matching a client's re-sent document to the invoice that was returned.
 * See docs/feature_flags.md.
 */

export const RETURN_REASONS = [
  { code: 'unreadable', label: 'מסמך לא קריא' },
  { code: 'missing_allocation', label: 'חסר מספר הקצאה' },
  { code: 'not_tax_invoice', label: 'לא חשבונית מס' },
  { code: 'private_expense', label: 'הוצאה פרטית' },
  { code: 'other', label: 'אחר' },
] as const;

export type ReturnReasonCode = (typeof RETURN_REASONS)[number]['code'];

export const RETURN_NOTE_MAX_LENGTH = 500;
export const RETURN_NOTE_MIN_LENGTH_FOR_OTHER = 3;

/** Statuses an accountant may return to the client (not while processing, not after export). */
export const RETURNABLE_STATUSES: readonly InvoiceStatus[] = ['review', 'approved', 'rejected', 'error'];

export function canReturnInvoice(status: InvoiceStatus | string | null | undefined): boolean {
  return typeof status === 'string' && (RETURNABLE_STATUSES as readonly string[]).includes(status);
}

export function isReturnReasonCode(value: unknown): value is ReturnReasonCode {
  return typeof value === 'string' && RETURN_REASONS.some((r) => r.code === value);
}

export function returnReasonLabel(code: string | null | undefined): string | null {
  return RETURN_REASONS.find((r) => r.code === code)?.label ?? null;
}

export type ReturnReasonResult =
  | { ok: true; code: ReturnReasonCode; note: string | null; text: string }
  | { ok: false; error: string };

/** Control characters out, whitespace runs folded (newlines kept, max 2 in a row). */
function cleanNote(raw: string): string {
  return raw
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁦-⁩]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Validates the reason the accountant picked. A preset code is required; "אחר" also requires a
 * free-text note; any note is limited to RETURN_NOTE_MAX_LENGTH characters.
 * `text` is what is stored in invoices.return_reason and sent to the client.
 */
export function validateReturnReason(input: { code?: unknown; note?: unknown }): ReturnReasonResult {
  if (input.code === undefined || input.code === null || input.code === '') {
    return { ok: false, error: 'יש לבחור סיבה להחזרה' };
  }
  if (!isReturnReasonCode(input.code)) return { ok: false, error: 'סיבת החזרה לא מוכרת' };
  if (input.note !== undefined && input.note !== null && typeof input.note !== 'string') {
    return { ok: false, error: 'הערה לא תקינה' };
  }
  const note = typeof input.note === 'string' ? cleanNote(input.note) : '';
  if (note.length > RETURN_NOTE_MAX_LENGTH) {
    return { ok: false, error: `ההערה ארוכה מדי (עד ${RETURN_NOTE_MAX_LENGTH} תווים)` };
  }
  if (input.code === 'other' && note.length < RETURN_NOTE_MIN_LENGTH_FOR_OTHER) {
    return { ok: false, error: 'בבחירת "אחר" יש לפרט את הסיבה' };
  }
  const label = returnReasonLabel(input.code)!;
  const text = input.code === 'other' ? note : note ? `${label} - ${note}` : label;
  return { ok: true, code: input.code, note: note || null, text };
}

// ─── Notification channels ─────────────────────────────────────────────────────

export type NotificationChannel = 'email' | 'whatsapp';
export type NotificationStatus = 'sent' | 'failed' | 'not_sent';

/** Result of one planned send (POST /api/invoices/[id]/return response; also logged). */
export interface NotificationOutcome {
  channel: NotificationChannel;
  to: string | null;
  status: NotificationStatus;
  error: string | null;
}

/** Max WhatsApp contacts notified per return (a client may have several phones). */
export const MAX_WHATSAPP_RECIPIENTS = 3;

export interface ChannelSelectionInput {
  contactEmail: string | null | undefined;
  /** client_contacts phones (E.164), oldest first. */
  phones: string[];
  emailConfigured: boolean;
  whatsappConfigured: boolean;
}

/** One planned send. `skip` set → logged as not_sent with that reason, nothing is sent. */
export interface PlannedNotification {
  channel: NotificationChannel;
  to: string | null;
  skip: string | null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isPlausibleEmail(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.length <= 254 && EMAIL_RE.test(value.trim());
}

/**
 * Every channel the client could be reached on, each either to be sent or skipped with a
 * reason, so every attempt ends up in client_notifications:
 *   - email to clients.contact_email when SES is configured;
 *   - WhatsApp to each client_contacts phone (up to MAX_WHATSAPP_RECIPIENTS) when Twilio sending is configured.
 * A channel without any recipient yields one skipped entry (to = null).
 */
export function selectNotificationChannels(input: ChannelSelectionInput): PlannedNotification[] {
  const planned: PlannedNotification[] = [];

  const email = input.contactEmail?.trim().toLowerCase() || null;
  if (!email) {
    planned.push({ channel: 'email', to: null, skip: 'ללקוח לא הוגדרה כתובת אימייל לעדכונים' });
  } else if (!isPlausibleEmail(email)) {
    planned.push({ channel: 'email', to: email, skip: 'כתובת האימייל של הלקוח אינה תקינה' });
  } else if (!input.emailConfigured) {
    planned.push({ channel: 'email', to: email, skip: 'שליחת אימייל לא הוגדרה בשרת' });
  } else {
    planned.push({ channel: 'email', to: email, skip: null });
  }

  const phones = [...new Set(input.phones.filter((p) => typeof p === 'string' && p.trim()))];
  if (phones.length === 0) {
    planned.push({ channel: 'whatsapp', to: null, skip: 'ללקוח אין מספר וואטסאפ' });
  } else {
    phones.forEach((phone, index) => {
      let skip: string | null = null;
      if (index >= MAX_WHATSAPP_RECIPIENTS) skip = `נשלח רק ל-${MAX_WHATSAPP_RECIPIENTS} מספרים ראשונים`;
      else if (!input.whatsappConfigured) skip = 'שליחת וואטסאפ (Twilio) לא הוגדרה בשרת';
      planned.push({ channel: 'whatsapp', to: phone, skip });
    });
  }

  return planned;
}

// ─── Message text ──────────────────────────────────────────────────────────────

export interface ReturnMessageInput {
  clientName: string | null;
  officeName: string | null;
  fileName: string | null;
  supplierName: string | null;
  invoiceNumber: string | null;
  totalAmount: number | null;
  reasonText: string;
  /** Inbound email address of the client, if email ingestion is configured. */
  inboundEmail: string | null;
  /** Office WhatsApp number for documents, if configured. */
  whatsappNumber: string | null;
}

export interface ReturnMessage {
  subject: string;
  text: string;
}

export function buildReturnMessage(m: ReturnMessageInput): ReturnMessage {
  const office = m.officeName?.trim() || 'משרד הנהלת החשבונות';
  const docParts: string[] = [];
  if (m.supplierName) docParts.push(m.supplierName);
  if (m.invoiceNumber) docParts.push(`מס' ${m.invoiceNumber}`);
  if (m.totalAmount != null && Number.isFinite(m.totalAmount)) {
    docParts.push(`₪${m.totalAmount.toLocaleString('he-IL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  }
  const doc = docParts.length > 0 ? docParts.join(' · ') : (m.fileName || 'מסמך');

  const resend: string[] = [];
  if (m.inboundEmail) resend.push(`במייל לכתובת ${m.inboundEmail}`);
  if (m.whatsappNumber) resend.push(`בוואטסאפ למספר ${m.whatsappNumber}`);
  const resendLine = resend.length > 0
    ? `נא לשלוח מסמך מתוקן ${resend.join(' או ')}.`
    : 'נא לשלוח מסמך מתוקן בערוץ הרגיל.';

  const greeting = m.clientName?.trim() ? `שלום ${m.clientName.trim()},` : 'שלום,';
  const text = [
    greeting,
    `${office} החזיר/ה אליך את המסמך: ${doc}.`,
    `סיבה: ${m.reasonText}`,
    resendLine,
    'תודה!',
  ].join('\n');

  return { subject: `מסמך הוחזר לתיקון: ${doc}`, text };
}

// ─── Resubmission matching ─────────────────────────────────────────────────────

/** A returned invoice of the same client that a new document may replace. */
export interface ReturnedCandidate {
  id: string;
  returned_at?: string | null;
  resubmitted_invoice_id?: string | null;
  extracted_data?: Partial<ExtractedData> | null;
  validated_data?: Partial<ExtractedData> | null;
}

// Legal-form suffixes ignored when comparing supplier names ('בע"מ' becomes 'בעמ' after folding).
const COMPANY_SUFFIXES = new Set(['בעמ', 'ltd', 'inc', 'limited']);

function foldSupplierName(value: string | null | undefined): string | null {
  if (!value) return null;
  const folded = value
    .toLowerCase()
    .replace(/[ךםןףץ]/g, (c) => ({ 'ך': 'כ', 'ם': 'מ', 'ן': 'נ', 'ף': 'פ', 'ץ': 'צ' } as Record<string, string>)[c])
    .replace(/["'״׳]/g, '')
    .replace(/[^0-9a-zא-ת]+/g, ' ')
    .split(' ')
    .filter((token) => token && !COMPANY_SUFFIXES.has(token))
    .join(' ');
  return folded || null;
}

function sameSupplier(a: Partial<ExtractedData>, b: Partial<ExtractedData>): boolean {
  const vatA = normalizeVatId(a.supplier_vat_id);
  const vatB = normalizeVatId(b.supplier_vat_id);
  if (vatA && vatB) return vatA === vatB;
  const nameA = foldSupplierName(a.supplier_name);
  const nameB = foldSupplierName(b.supplier_name);
  return !!nameA && nameA === nameB;
}

/**
 * The returned invoice a newly processed document replaces: same supplier (VAT id when both have
 * one, else folded name) and same normalized invoice number, not yet linked to another
 * resubmission. Most recently returned first. null when there is no such invoice.
 */
export function findReturnedMatch(
  newInvoiceId: string,
  data: Partial<ExtractedData> | null | undefined,
  candidates: ReturnedCandidate[]
): ReturnedCandidate | null {
  if (!data) return null;
  const number = normalizeInvoiceNumber(data.invoice_number);
  if (!number) return null;

  const matches = candidates.filter((c) => {
    if (c.id === newInvoiceId) return false;
    if (c.resubmitted_invoice_id && c.resubmitted_invoice_id !== newInvoiceId) return false;
    const other = c.validated_data ?? c.extracted_data;
    if (!other) return false;
    return normalizeInvoiceNumber(other.invoice_number) === number && sameSupplier(data, other);
  });
  matches.sort((a, b) => (b.returned_at ?? '').localeCompare(a.returned_at ?? ''));
  return matches[0] ?? null;
}

/** Recipient shown in logs / UI without exposing the whole address or phone. */
export function maskRecipient(channel: NotificationChannel, to: string | null): string | null {
  if (!to) return null;
  if (channel === 'email') {
    const [local, domain] = to.split('@');
    if (!domain) return '***';
    return `${local.slice(0, 2)}***@${domain}`;
  }
  return to.length > 4 ? `${'*'.repeat(Math.max(0, to.length - 4))}${to.slice(-4)}` : '****';
}
