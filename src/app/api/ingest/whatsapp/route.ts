import { ingestDocument, isAlreadyIngested } from '@/lib/ingest';
import { findClientByPhone } from '@/lib/clientChannels';
import {
  buildTwimlMessage,
  detectDocumentMime,
  ensureExtension,
  isTrustedTwilioMediaUrl,
  MAX_DOCUMENT_BYTES,
  normalizePhone,
  parseTwilioMedia,
  readBodyText,
  validateTwilioSignature,
  whatsappReplyText,
  type TwilioMedia,
  type WhatsAppIngestOutcome,
} from '@/lib/ingestHelpers';

export const runtime = 'nodejs';

/** Twilio waits ~15s for the webhook; keep each media download well under that. */
const MEDIA_TIMEOUT_MS = 10_000;

/** Twilio webhook bodies are a few KB; cap what we read before the signature is checked. */
const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;

function twiml(message: string | null, status = 200): Response {
  return new Response(buildTwimlMessage(message), {
    status,
    headers: { 'Content-Type': 'text/xml; charset=utf-8' },
  });
}

/**
 * The exact public URL Twilio posted to - required for the signature. Behind a proxy / CDN the
 * request URL may differ, so TWILIO_WEBHOOK_URL (the URL configured in the Twilio console) wins.
 */
function webhookUrl(request: Request): string {
  const configured = process.env.TWILIO_WEBHOOK_URL?.trim();
  if (configured) return configured;
  const url = new URL(request.url);
  const proto = request.headers.get('x-forwarded-proto')?.split(',')[0].trim() || url.protocol.replace(':', '');
  const host = request.headers.get('x-forwarded-host')?.split(',')[0].trim() || request.headers.get('host') || url.host;
  return `${proto}://${host}${url.pathname}${url.search}`;
}

type MediaResult =
  | { kind: 'ok'; bytes: Uint8Array; mime: 'application/pdf' | 'image/jpeg' | 'image/png' }
  | { kind: 'unsupported' }
  | { kind: 'failed'; error: string };

async function downloadMedia(media: TwilioMedia, accountSid: string, authToken: string): Promise<MediaResult> {
  if (!isTrustedTwilioMediaUrl(media.url)) {
    return { kind: 'failed', error: `Untrusted media URL host: ${media.url}` };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MEDIA_TIMEOUT_MS);
  try {
    // Twilio redirects to a pre-signed CDN URL; fetch drops the Authorization header on the
    // cross-origin redirect, which is what we want.
    const res = await fetch(media.url, {
      headers: { Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}` },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!res.ok) return { kind: 'failed', error: `Media download failed: HTTP ${res.status}` };

    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared > MAX_DOCUMENT_BYTES) return { kind: 'failed', error: 'Media exceeds size limit' };

    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > MAX_DOCUMENT_BYTES) return { kind: 'failed', error: 'Media exceeds size limit' };

    const mime = detectDocumentMime(bytes);
    if (!mime) return { kind: 'unsupported' };
    return { kind: 'ok', bytes, mime };
  } catch (err) {
    return { kind: 'failed', error: `Media download failed: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Twilio WhatsApp inbound webhook (application/x-www-form-urlencoded).
 * Verifies X-Twilio-Signature, maps the sender phone to a client via client_contacts, ingests
 * every media item with source='whatsapp' and replies to the sender with TwiML in Hebrew.
 */
export async function POST(request: Request) {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  if (!authToken || !accountSid) {
    console.error('[Ingest WhatsApp] TWILIO_AUTH_TOKEN / TWILIO_ACCOUNT_SID not set - rejecting webhook.');
    return new Response('WhatsApp ingestion is not configured', { status: 503 });
  }

  let params: URLSearchParams;
  try {
    const raw = await readBodyText(request, MAX_WEBHOOK_BODY_BYTES);
    if (raw === null) return new Response('Payload too large', { status: 413 });
    params = new URLSearchParams(raw);
  } catch (err) {
    console.error('[Ingest WhatsApp] Could not read request body:', err);
    return new Response('Bad request', { status: 400 });
  }

  const signature = request.headers.get('x-twilio-signature');
  if (!validateTwilioSignature(authToken, signature, webhookUrl(request), params)) {
    console.warn('[Ingest WhatsApp] Invalid or missing X-Twilio-Signature.');
    return new Response('Invalid signature', { status: 403 });
  }

  // Only our own account's traffic.
  if (params.get('AccountSid') && params.get('AccountSid') !== accountSid) {
    return new Response('Unknown account', { status: 403 });
  }

  const from = params.get('From') ?? '';
  const sender = normalizePhone(from);
  const messageSid = params.get('MessageSid') ?? params.get('SmsMessageSid');

  try {
    const match = sender ? await findClientByPhone(sender) : null;
    if (!match) {
      console.warn(`[Ingest WhatsApp] Unknown sender ${sender ?? from}`);
      return twiml(whatsappReplyText({ knownSender: false, received: 0, unsupported: 0, failed: 0 }));
    }

    const outcome: WhatsAppIngestOutcome = { knownSender: true, received: 0, unsupported: 0, failed: 0 };
    const mediaItems = parseTwilioMedia(params);

    // Download in parallel so a multi-photo message still answers inside Twilio's timeout.
    const sourceRefs = mediaItems.map((_, i) => (messageSid ? `whatsapp:${messageSid}#${i}` : null));
    const duplicates = await Promise.all(sourceRefs.map((ref) => (ref ? isAlreadyIngested(ref) : Promise.resolve(false))));
    const downloads = await Promise.all(
      mediaItems.map((item, i) => (duplicates[i] ? Promise.resolve(null) : downloadMedia(item, accountSid, authToken)))
    );

    for (let i = 0; i < mediaItems.length; i++) {
      const sourceRef = sourceRefs[i];
      const media = downloads[i];
      if (!media) {
        outcome.received++; // Twilio retry of a message we already ingested.
        continue;
      }
      if (media.kind === 'unsupported') {
        outcome.unsupported++;
        continue;
      }
      if (media.kind === 'failed') {
        console.error(`[Ingest WhatsApp] ${media.error}`);
        outcome.failed++;
        continue;
      }

      // Sequential on purpose: the local mock DB's read-modify-write isn't safe for parallel inserts.
      const stamp = new Date().toISOString().slice(0, 10);
      const result = await ingestDocument({
        clientId: match.clientId,
        fileName: ensureExtension(`whatsapp_${stamp}_${i + 1}`, media.mime),
        mimeType: media.mime,
        bytes: media.bytes,
        source: 'whatsapp',
        sender,
        sourceRef,
      });
      if (result.status === 'success' || result.duplicate) {
        outcome.received++;
      } else {
        console.error(`[Ingest WhatsApp] Ingest failed: ${result.error}`);
        outcome.failed++;
      }
    }

    console.log(
      `[Ingest WhatsApp] client=${match.clientId} from=${sender} received=${outcome.received} unsupported=${outcome.unsupported} failed=${outcome.failed}`
    );
    return twiml(whatsappReplyText(outcome));
  } catch (err) {
    console.error('[Ingest WhatsApp] Handler crashed:', err);
    return twiml('אירעה שגיאה בקליטת המסמך. נסו שוב מאוחר יותר.');
  }
}
