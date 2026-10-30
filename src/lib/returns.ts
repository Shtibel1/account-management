import type { SupabaseClient } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import { escapeHtml, sendEmail } from '@/lib/email';
import { sendWhatsAppText, whatsappSendConfig } from '@/lib/whatsappSend';
import { formatPhoneForDisplay } from '@/lib/phone';
import { isEnabledForClient } from '@/lib/featureFlags';
import { dismissDuplicateInFlags } from '@/shared/duplicates';
import {
  buildReturnMessage,
  canReturnInvoice,
  findReturnedMatch,
  maskRecipient,
  selectNotificationChannels,
  type NotificationOutcome,
  type ReturnedCandidate,
  type ReturnReasonCode,
} from '@/shared/returns';
import type { ClientNotification, ExtractedData, Invoice, InvoiceStatus } from '@/shared/types';

/**
 * SERVER-ONLY accountant review loop (feature flag accountant_review_loop): return an invoice to
 * the client with a reason, notify the client (email via SES / WhatsApp via Twilio, every attempt
 * logged in client_notifications), and link a corrected document the client sends later.
 * Callers must have checked access to the invoice (requireInvoiceAccess) and the flag.
 */

export const RETURN_WARNING = 'מסמך מתוקן לחשבונית שהוחזרה ללקוח';

export class ReturnInvoiceError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'ReturnInvoiceError';
  }
}

/** Sender for client notification emails (null = email notifications not configured). */
export function notificationEmailFrom(env: NodeJS.ProcessEnv = process.env): string | null {
  const from = (env.CLIENT_NOTIFY_EMAIL_FROM || env.CONTACT_FROM_EMAIL || env.CONTACT_FROM || '').trim();
  return from || null;
}

interface ReturnDeps {
  db: SupabaseClient;
  sendEmail: typeof sendEmail;
  sendWhatsApp: typeof sendWhatsAppText;
  env: NodeJS.ProcessEnv;
}

const deps: ReturnDeps = { db: supabase, sendEmail, sendWhatsApp: sendWhatsAppText, env: process.env };

/** Test hook. Not used by the app. */
export function setReturnDependenciesForTests(overrides: Partial<ReturnDeps>): void {
  Object.assign(deps, overrides);
}

export type { NotificationOutcome };

interface ClientRow {
  id: string;
  name: string | null;
  org_id?: string | null;
  contact_email?: string | null;
  inbound_alias?: string | null;
}

async function loadClient(clientId: string): Promise<ClientRow | null> {
  const { data, error } = await deps.db.from('clients').select('*').eq('id', clientId).limit(1);
  if (error) throw new Error(`Failed to load client ${clientId}: ${error.message}`);
  return ((Array.isArray(data) ? data[0] : null) as ClientRow | undefined) ?? null;
}

async function loadPhones(clientId: string): Promise<string[]> {
  const { data, error } = await deps.db
    .from('client_contacts')
    .select('phone, created_at')
    .eq('client_id', clientId)
    .order('created_at', { ascending: true });
  if (error) {
    console.warn('[returns] client_contacts unavailable, skipping WhatsApp:', error.message);
    return [];
  }
  return ((data ?? []) as { phone: string }[]).map((c) => c.phone).filter(Boolean);
}

async function loadOfficeName(orgId: string | null): Promise<string | null> {
  if (!orgId) return null;
  const { data, error } = await deps.db.from('organizations').select('name').eq('id', orgId).limit(1);
  if (error) return null;
  return ((Array.isArray(data) ? data[0] : null) as { name?: string } | undefined)?.name ?? null;
}

function htmlEmail(text: string): string {
  return `<!DOCTYPE html>
<html dir="rtl" lang="he">
<head><meta charset="UTF-8"></head>
<body style="font-family: Heebo, Arial, sans-serif; line-height: 1.6; color: #1c1917; background: #f5f5f4; margin: 0; padding: 20px;">
  <div style="max-width: 600px; margin: 0 auto; background: #fff; border-radius: 12px; padding: 28px; direction: rtl; text-align: right;">
    ${escapeHtml(text)}
  </div>
</body>
</html>`;
}

async function logNotification(row: {
  orgId: string | null;
  clientId: string;
  invoiceId: string;
  userId: string | null;
  outcome: NotificationOutcome;
  providerMessageId: string | null;
}): Promise<void> {
  if (!row.orgId) {
    console.error(`[returns] Cannot log ${row.outcome.channel} notification for invoice ${row.invoiceId}: unknown office`);
    return;
  }
  const { error } = await deps.db.from('client_notifications').insert({
    org_id: row.orgId,
    client_id: row.clientId,
    invoice_id: row.invoiceId,
    kind: 'invoice_returned',
    channel: row.outcome.channel,
    recipient: row.outcome.to,
    status: row.outcome.status,
    error: row.outcome.error,
    provider_message_id: row.providerMessageId,
    created_by: row.userId,
  });
  if (error) {
    // The return itself already happened; a missing log row must not fail the request.
    console.error(
      `[returns] Failed to log ${row.outcome.channel} notification (${row.outcome.status}) for invoice ${row.invoiceId}:`,
      error.message
    );
  }
}

/**
 * Notifies the client that the invoice was returned, on every configured channel, and logs each
 * attempt (sent / failed / not_sent). Never throws for a send failure.
 */
export async function notifyClientOfReturn(params: {
  invoice: Pick<Invoice, 'id' | 'file_name' | 'validated_data' | 'extracted_data'>;
  clientId: string;
  orgId: string | null;
  userId: string | null;
  reasonText: string;
}): Promise<NotificationOutcome[]> {
  const client = await loadClient(params.clientId);
  const orgId = params.orgId ?? client?.org_id ?? null;
  const [phones, officeName] = await Promise.all([loadPhones(params.clientId), loadOfficeName(orgId)]);

  const emailFrom = notificationEmailFrom(deps.env);
  const waConfig = whatsappSendConfig(deps.env);
  const plan = selectNotificationChannels({
    contactEmail: client?.contact_email ?? null,
    phones,
    emailConfigured: !!emailFrom,
    whatsappConfigured: !!waConfig,
  });

  const data: Partial<ExtractedData> = params.invoice.validated_data ?? params.invoice.extracted_data ?? {};
  const domain = deps.env.INBOUND_EMAIL_DOMAIN?.trim();
  const message = buildReturnMessage({
    clientName: client?.name ?? null,
    officeName,
    fileName: params.invoice.file_name,
    supplierName: data.supplier_name ?? null,
    invoiceNumber: data.invoice_number ?? null,
    totalAmount: typeof data.total_amount === 'number' ? data.total_amount : null,
    reasonText: params.reasonText,
    inboundEmail: domain && client?.inbound_alias ? `${client.inbound_alias}@${domain}` : null,
    whatsappNumber: waConfig ? formatPhoneForDisplay(waConfig.from) : null,
  });

  const outcomes: NotificationOutcome[] = [];
  for (const item of plan) {
    let outcome: NotificationOutcome;
    let providerMessageId: string | null = null;
    if (item.skip || !item.to) {
      outcome = { channel: item.channel, to: item.to, status: 'not_sent', error: item.skip ?? 'אין נמען' };
    } else if (item.channel === 'email') {
      try {
        providerMessageId = await deps.sendEmail({
          from: emailFrom!,
          to: [item.to],
          subject: message.subject,
          textBody: message.text,
          htmlBody: htmlEmail(message.text),
        });
        outcome = { channel: 'email', to: item.to, status: 'sent', error: null };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        outcome = { channel: 'email', to: item.to, status: 'failed', error: `SES: ${msg}`.slice(0, 300) };
      }
    } else {
      const res = await deps.sendWhatsApp(waConfig!, item.to, message.text).catch((err: unknown) => ({
        ok: false as const,
        error: `Twilio: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300),
      }));
      outcome = res.ok
        ? { channel: 'whatsapp', to: item.to, status: 'sent', error: null }
        : { channel: 'whatsapp', to: item.to, status: 'failed', error: res.error };
      if (res.ok) providerMessageId = res.sid;
    }

    console.log(
      `[returns] Invoice ${params.invoice.id}: ${outcome.channel} → ${maskRecipient(outcome.channel, outcome.to) ?? '-'}: ${outcome.status}`
    );
    await logNotification({
      orgId,
      clientId: params.clientId,
      invoiceId: params.invoice.id,
      userId: params.userId,
      outcome,
      providerMessageId,
    });
    outcomes.push(outcome);
  }
  return outcomes;
}

type ReturnableInvoice = Pick<Invoice, 'id' | 'client_id' | 'status' | 'file_name' | 'validated_data' | 'extracted_data'>;

/**
 * Marks the invoice as returned (status 'returned' + reason / time / user) and notifies the
 * client. 409 when the invoice isn't in a returnable status (processing, exported, already returned).
 */
export async function returnInvoiceToClient(params: {
  invoiceId: string;
  orgId: string | null;
  userId: string | null;
  reason: { code: ReturnReasonCode; text: string };
}): Promise<{ invoice: Invoice; notifications: NotificationOutcome[] }> {
  const { data: rows, error: loadErr } = await deps.db
    .from('invoices')
    .select('id, client_id, status, file_name, validated_data, extracted_data')
    .eq('id', params.invoiceId)
    .limit(1);
  if (loadErr) throw new Error(`Failed to load invoice: ${loadErr.message}`);
  const current = ((Array.isArray(rows) ? rows[0] : null) as ReturnableInvoice | undefined) ?? null;
  if (!current) throw new ReturnInvoiceError('החשבונית לא נמצאה', 404);
  if (!canReturnInvoice(current.status)) {
    throw new ReturnInvoiceError(
      current.status === 'returned' ? 'החשבונית כבר הוחזרה ללקוח' : 'לא ניתן להחזיר חשבונית בסטטוס הנוכחי',
      409
    );
  }

  // An approved invoice may already be matched to a bank statement line; returning it would leave
  // the line matched to a document that is no longer a valid expense. Ask for an unmatch first.
  if (current.status === 'approved') {
    const { data: matched, error: bankErr } = await deps.db
      .from('bank_transactions')
      .select('id')
      .eq('matched_invoice_id', current.id)
      .limit(1);
    if (bankErr) {
      console.warn(`[returns] bank_transactions unavailable, skipping match check for ${current.id}:`, bankErr.message);
    } else if (Array.isArray(matched) && matched.length > 0) {
      throw new ReturnInvoiceError('החשבונית מותאמת לתנועת בנק - יש לבטל את ההתאמה במסך התאמות בנק לפני ההחזרה ללקוח', 409);
    }
  }

  const returnedAt = new Date().toISOString();
  // Conditional update that returns the rows it changed: an empty result means somebody changed
  // the status meanwhile and NOTHING was written (no reload / timestamp string compare - PostgREST
  // renders timestamptz as '+00:00', never as the 'Z' of toISOString()).
  const { data: changedRows, error: updErr } = await deps.db
    .from('invoices')
    .update({
      status: 'returned' satisfies InvoiceStatus,
      return_reason_code: params.reason.code,
      return_reason: params.reason.text,
      returned_at: returnedAt,
      returned_by: params.userId,
      updated_at: returnedAt,
    })
    .eq('id', current.id)
    .eq('status', current.status) // only if nobody changed it meanwhile
    .select('*');
  if (updErr) throw new Error(`Failed to mark the invoice as returned: ${updErr.message}`);
  const updated = ((Array.isArray(changedRows) ? changedRows[0] : null) as Invoice | undefined) ?? null;
  if (!updated) {
    throw new ReturnInvoiceError('החשבונית עודכנה במקביל - רעננו ונסו שוב', 409);
  }

  // The status change is committed: from here on the request succeeds and the client is notified.
  // Every channel attempt is logged (sent / failed / not_sent); an unexpected error while preparing
  // the notifications is logged as 'failed' rows instead of failing the (already done) return.
  let notifications: NotificationOutcome[];
  try {
    notifications = await notifyClientOfReturn({
      invoice: current,
      clientId: current.client_id,
      orgId: params.orgId,
      userId: params.userId,
      reasonText: params.reason.text,
    });
  } catch (err) {
    const msg = (err instanceof Error ? err.message : String(err)).slice(0, 250);
    console.error(`[returns] Notifying the client of returned invoice ${current.id} failed:`, msg);
    notifications = [];
    for (const channel of ['email', 'whatsapp'] as const) {
      const outcome: NotificationOutcome = { channel, to: null, status: 'failed', error: `שגיאה בהכנת ההודעה: ${msg}` };
      await logNotification({
        orgId: params.orgId,
        clientId: current.client_id,
        invoiceId: current.id,
        userId: params.userId,
        outcome,
        providerMessageId: null,
      }).catch(() => undefined);
      notifications.push(outcome);
    }
  }
  return { invoice: updated, notifications };
}

/** Notification log of an invoice, newest first. */
export async function listInvoiceNotifications(invoiceId: string): Promise<ClientNotification[]> {
  const { data, error } = await deps.db
    .from('client_notifications')
    .select('*')
    .eq('invoice_id', invoiceId)
    .order('created_at', { ascending: false });
  if (error) {
    console.warn('[returns] client_notifications unavailable (migration not applied?):', error.message);
    return [];
  }
  return (data ?? []) as ClientNotification[];
}

/**
 * Called by the pipeline after a document was extracted: if the client previously had an invoice
 * of the same supplier + number returned, link the two (returned.resubmitted_invoice_id ↔
 * new.resubmission_of), add a warning to the new invoice and drop the duplicate flag that points
 * at the returned one. Best-effort: never throws, no-op while the flag is off for the office.
 */
export async function linkResubmission(invoiceId: string): Promise<string | null> {
  try {
    const { data: rows, error } = await deps.db.from('invoices').select('*').eq('id', invoiceId).limit(1);
    if (error) throw new Error(error.message);
    const invoice = ((Array.isArray(rows) ? rows[0] : null) as Invoice | undefined) ?? null;
    if (!invoice || invoice.resubmission_of) return invoice?.resubmission_of ?? null;
    if (!(await isEnabledForClient(invoice.client_id, 'accountant_review_loop'))) return null;

    const data = invoice.validated_data ?? invoice.extracted_data;
    if (!data?.invoice_number) return null;

    const { data: candidates, error: candErr } = await deps.db
      .from('invoices')
      .select('*')
      .eq('client_id', invoice.client_id)
      .eq('status', 'returned');
    if (candErr) throw new Error(candErr.message);

    const match = findReturnedMatch(invoice.id, data, (candidates ?? []) as ReturnedCandidate[]);
    if (!match) return null;

    const validated = invoice.validated_data;
    let nextValidated = validated;
    if (validated?.validation_flags) {
      const current = validated.validation_flags;
      // The returned invoice is the document being replaced, not a duplicate of it.
      const flags = (current.duplicate_matches ?? []).some((m) => m.invoice_id === match.id)
        ? dismissDuplicateInFlags(current, match.id, validated.invoice_number ?? null)
        : { ...current };
      const warnings = flags.warnings ?? [];
      flags.warnings = warnings.includes(RETURN_WARNING) ? warnings : [...warnings, RETURN_WARNING];
      nextValidated = { ...validated, validation_flags: flags };
    }

    const now = new Date().toISOString();
    const { error: newErr } = await deps.db
      .from('invoices')
      .update({ resubmission_of: match.id, validated_data: nextValidated, updated_at: now })
      .eq('id', invoice.id);
    if (newErr) throw new Error(newErr.message);
    const { error: oldErr } = await deps.db
      .from('invoices')
      .update({ resubmitted_invoice_id: invoice.id, updated_at: now })
      .eq('id', match.id);
    if (oldErr) throw new Error(oldErr.message);

    console.log(`[returns] Invoice ${invoice.id} linked as the corrected document of returned invoice ${match.id}`);
    return match.id;
  } catch (err) {
    console.error(`[returns] Failed to link resubmission for invoice ${invoiceId}:`, err);
    return null;
  }
}
