import { normalizePhone } from '@/lib/phone';

/**
 * SERVER-ONLY outgoing WhatsApp message through the Twilio REST API (no twilio npm package).
 * Reuses the ingestion env (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN, docs/ingestion.md); the sender
 * is TWILIO_WHATSAPP_FROM, falling back to TWILIO_WHATSAPP_NUMBER. The auth token is only sent in
 * the Authorization header to api.twilio.com and is never logged or returned.
 *
 * Note: WhatsApp only delivers free-form text inside the 24h window after the client last wrote to
 * the number; outside it Twilio returns an error (logged as 'failed') unless an approved template
 * is used. See docs/feature_flags.md.
 */

const TWILIO_API = 'https://api.twilio.com/2010-04-01';
const SEND_TIMEOUT_MS = 10_000;
const MAX_BODY_LENGTH = 1500;

export interface WhatsAppSendConfig {
  accountSid: string;
  authToken: string;
  from: string; // E.164
}

export function whatsappSendConfig(env: NodeJS.ProcessEnv = process.env): WhatsAppSendConfig | null {
  const accountSid = env.TWILIO_ACCOUNT_SID?.trim();
  const authToken = env.TWILIO_AUTH_TOKEN?.trim();
  const from = normalizePhone(env.TWILIO_WHATSAPP_FROM || env.TWILIO_WHATSAPP_NUMBER || '');
  if (!accountSid || !authToken || !from) return null;
  if (!/^AC[0-9a-fA-F]{32}$/.test(accountSid)) return null;
  return { accountSid, authToken, from };
}

export type WhatsAppSendResult = { ok: true; sid: string | null } | { ok: false; error: string };

/** Sends one WhatsApp text. Never throws; errors come back as a short message without secrets. */
export async function sendWhatsAppText(
  config: WhatsAppSendConfig,
  toE164: string,
  body: string,
  fetchImpl: typeof fetch = fetch
): Promise<WhatsAppSendResult> {
  const to = normalizePhone(toE164);
  if (!to) return { ok: false, error: 'מספר טלפון לא תקין' };

  const form = new URLSearchParams({
    From: `whatsapp:${config.from}`,
    To: `whatsapp:${to}`,
    Body: body.length > MAX_BODY_LENGTH ? `${body.slice(0, MAX_BODY_LENGTH - 1)}…` : body,
  });
  const auth = Buffer.from(`${config.accountSid}:${config.authToken}`).toString('base64');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${TWILIO_API}/Accounts/${encodeURIComponent(config.accountSid)}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
      signal: controller.signal,
    });
    const json = (await res.json().catch(() => null)) as { sid?: string; message?: string; code?: number } | null;
    if (!res.ok) {
      const detail = json?.message ? `${json.code ? `${json.code}: ` : ''}${json.message}` : `HTTP ${res.status}`;
      return { ok: false, error: `Twilio: ${detail}`.slice(0, 300) };
    }
    return { ok: true, sid: json?.sid ?? null };
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    return { ok: false, error: aborted ? 'Twilio: תם הזמן לשליחה' : `Twilio: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300) };
  } finally {
    clearTimeout(timer);
  }
}
