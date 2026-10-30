import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import type { InvoiceSource } from '@/shared/types';

/**
 * Pure helpers for the ingestion channels (upload / email / WhatsApp).
 * No database or network access here so everything can be unit-tested in isolation.
 */

export type { InvoiceSource };

export type SupportedMimeType = 'application/pdf' | 'image/jpeg' | 'image/png';

/** Max size of a single ingested document (matches the 20MB limit shown in UploadZone). */
export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;

/** Images smaller than this are almost always signature logos / tracking pixels, not invoices. */
export const MIN_EMAIL_IMAGE_BYTES = 15 * 1024;

/** Max documents taken from a single email / WhatsApp message (Twilio caps WhatsApp at 10 media). */
export const MAX_DOCUMENTS_PER_MESSAGE = 10;

// ── Storage naming ─────────────────────────────────────────────────────────────

/** Makes a filename safe for a Supabase Storage key (ASCII only), keeping the extension. */
export function sanitizeStorageFilename(fileName: string): string {
  const lastDot = fileName.lastIndexOf('.');
  // Extension: ASCII alphanumerics only (a "/" there would otherwise leak into the storage key).
  const ext = lastDot !== -1 ? fileName.substring(lastDot).replace(/[^a-zA-Z0-9.]/g, '') : '';
  const nameWithoutExt = lastDot !== -1 ? fileName.substring(0, lastDot) : fileName;

  let sanitized = nameWithoutExt
    .replace(/[^a-zA-Z0-9-.]/g, '_')
    .replace(/__+/g, '_')
    .replace(/--+/g, '-')
    .replace(/^[_-]+|[_-]+$/g, '');

  if (!sanitized) {
    sanitized = Buffer.from(nameWithoutExt).toString('hex').substring(0, 16);
  }

  return `${sanitized}${ext}`;
}

/** Storage key inside the raw-invoices bucket: <clientId>/<timestamp>_<safe name>. */
export function buildStoragePath(clientId: string, fileName: string, now: number = Date.now()): string {
  return `${clientId}/${now}_${sanitizeStorageFilename(fileName)}`;
}

/**
 * True when `filePath` is a single file directly inside the client's folder, in the shape
 * buildStoragePath() produces (no traversal, no nested folders, no other client's prefix).
 */
export function isOwnStoragePath(clientId: string, filePath: string): boolean {
  if (!clientId || typeof filePath !== 'string') return false;
  const prefix = `${clientId}/`;
  if (!filePath.startsWith(prefix)) return false;
  const rest = filePath.slice(prefix.length);
  return rest.length > 0 && rest.length <= 300 && !rest.includes('/') && !rest.includes('\\') && rest !== '.' && rest !== '..';
}

/**
 * invoices.file_url forms of a raw-invoices object:
 *   /storage/v1/object/authenticated/raw-invoices/<path>  - the stored reference (since QA #31): NOT a
 *     bearer link (needs a service / user JWT); readers get short-lived signed URLs on demand
 *     (src/lib/invoiceFiles.ts);
 *   /storage/v1/object/sign/raw-invoices/<path>?token=... - legacy 1-year signed URLs (rewritten by
 *     migration 20261030162000_qa_export_security.sql);
 *   /storage/v1/object/public/raw-invoices/<path>         - older public-bucket URLs.
 */
export const STORAGE_OBJECT_PATH_RE = /^\/storage\/v1\/object\/(?:authenticated|sign|public)\/raw-invoices\/(.+)$/;

/** Storage reference URL (not a bearer link) of a raw-invoices object, stored in invoices.file_url. */
export function storageReferenceUrl(supabaseBaseUrl: string, objectPath: string): string {
  const origin = new URL(supabaseBaseUrl).origin;
  return `${origin}/storage/v1/object/authenticated/raw-invoices/${objectPath.split('/').map(encodeURIComponent).join('/')}`;
}

/** Object path of a trusted file_url of this client (any of the forms above), else null. */
export function clientStorageObjectPath(fileUrl: unknown, clientId: string, supabaseBaseUrl: string | null): string | null {
  if (!isClientStorageFileUrl(fileUrl, clientId, supabaseBaseUrl)) return null;
  const match = STORAGE_OBJECT_PATH_RE.exec(new URL(fileUrl as string).pathname);
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * True when `fileUrl` (an invoices.file_url value, which signed-in users can edit) points at a file
 * of this client in the raw-invoices bucket of our own Supabase project. Server routes that fetch
 * file_url (process / split) must check this first: otherwise a user could make the server fetch an
 * arbitrary URL (SSRF) or another office's file.
 */
export function isClientStorageFileUrl(fileUrl: unknown, clientId: string, supabaseBaseUrl: string | null): boolean {
  if (typeof fileUrl !== 'string' || !clientId || !supabaseBaseUrl) return false;
  let url: URL;
  let base: URL;
  try {
    url = new URL(fileUrl);
    base = new URL(supabaseBaseUrl);
  } catch {
    return false;
  }
  if (url.origin !== base.origin || url.username || url.password) return false;
  const match = STORAGE_OBJECT_PATH_RE.exec(url.pathname);
  if (!match) return false;
  let objectPath: string;
  try {
    objectPath = decodeURIComponent(match[1]);
  } catch {
    return false;
  }
  return isOwnStoragePath(clientId, objectPath);
}

// ── File type detection ───────────────────────────────────────────────────────

const EXTENSION_BY_MIME: Record<SupportedMimeType, string> = {
  'application/pdf': '.pdf',
  'image/jpeg': '.jpg',
  'image/png': '.png',
};

/** Detects the real document type from magic bytes (the declared content type is only a hint). */
export function detectDocumentMime(bytes: Uint8Array): SupportedMimeType | null {
  if (bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d) {
    return 'application/pdf'; // %PDF-
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  return null;
}

/** Cheap pre-filter on the declared type / filename, before decoding the attachment. */
export function looksLikeDocument(contentType: string | null | undefined, fileName: string | null | undefined): boolean {
  const type = (contentType ?? '').toLowerCase().split(';')[0].trim();
  if (type === 'application/pdf' || type === 'image/jpeg' || type === 'image/jpg' || type === 'image/png') return true;
  // Some mail clients send PDFs as application/octet-stream.
  return /\.(pdf|jpe?g|png)$/i.test(fileName ?? '');
}

/** Ensures the stored filename carries an extension that matches the detected type. */
export function ensureExtension(fileName: string, mime: SupportedMimeType): string {
  const base = fileName.trim() || 'document';
  const wanted = EXTENSION_BY_MIME[mime];
  const lower = base.toLowerCase();
  if (mime === 'image/jpeg' && (lower.endsWith('.jpg') || lower.endsWith('.jpeg'))) return base;
  return lower.endsWith(wanted) ? base : `${base}${wanted}`;
}

// ── Request bodies ────────────────────────────────────────────────────────────

/**
 * Reads a request body as UTF-8 text, giving up (null) once it exceeds `maxBytes`.
 * Unlike request.text() this doesn't buffer an unbounded body when Content-Length is missing or wrong.
 */
export async function readBodyText(request: Request, maxBytes: number): Promise<string | null> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > maxBytes) return null;
  if (!request.body) return '';

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// ── Secrets ───────────────────────────────────────────────────────────────────

/** Constant-time string comparison (hashing first so differing lengths don't leak through timing). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

/**
 * Pulls the shared secret from an inbound-email webhook request. Accepted forms:
 *  - `X-Ingest-Secret: <secret>` (generic / Lambda forwarder)
 *  - `Authorization: Bearer <secret>`
 *  - `Authorization: Basic base64(<any user>:<secret>)` (Postmark: https://user:secret@host/... in the webhook URL)
 */
export function extractIngestSecret(headers: { get(name: string): string | null }): string | null {
  const direct = headers.get('x-ingest-secret');
  if (direct) return direct.trim();

  const auth = headers.get('authorization');
  if (!auth) return null;
  const [scheme, ...rest] = auth.trim().split(/\s+/);
  const value = rest.join(' ');
  if (!value) return null;
  if (scheme.toLowerCase() === 'bearer') return value;
  if (scheme.toLowerCase() === 'basic') {
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    return colon === -1 ? null : decoded.substring(colon + 1);
  }
  return null;
}

// ── Twilio ────────────────────────────────────────────────────────────────────

/**
 * Computes X-Twilio-Signature per Twilio's algorithm: the full webhook URL, followed by every
 * POST parameter sorted by name with its value appended (name+value, no delimiters),
 * HMAC-SHA1 with the account auth token, base64-encoded.
 * https://www.twilio.com/docs/usage/security#validating-requests
 */
export function computeTwilioSignature(authToken: string, url: string, params: URLSearchParams): string {
  const keys = Array.from(new Set(Array.from(params.keys()))).sort();
  let data = url;
  for (const key of keys) {
    for (const value of params.getAll(key).sort()) {
      data += key + value;
    }
  }
  return createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
}

export function validateTwilioSignature(
  authToken: string,
  signature: string | null,
  url: string,
  params: URLSearchParams
): boolean {
  if (!authToken || !signature) return false;
  return safeEqual(computeTwilioSignature(authToken, url, params), signature);
}

export interface TwilioMedia {
  url: string;
  contentType: string;
}

/** Reads MediaUrl0..N / MediaContentType0..N from a Twilio messaging webhook. */
export function parseTwilioMedia(params: URLSearchParams): TwilioMedia[] {
  const declared = Number.parseInt(params.get('NumMedia') ?? '0', 10);
  const count = Number.isFinite(declared) && declared > 0 ? Math.min(declared, MAX_DOCUMENTS_PER_MESSAGE) : 0;
  const media: TwilioMedia[] = [];
  for (let i = 0; i < count; i++) {
    const url = params.get(`MediaUrl${i}`);
    if (!url) continue;
    media.push({ url, contentType: params.get(`MediaContentType${i}`) ?? '' });
  }
  return media;
}

/** Only fetch media from Twilio's own API over HTTPS (we attach account credentials to the request). */
export function isTrustedTwilioMediaUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && (host === 'api.twilio.com' || host.endsWith('.twilio.com'));
  } catch {
    return false; // Not a URL at all.
  }
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** TwiML reply for a messaging webhook; no message → empty response (no reply sent). */
export function buildTwimlMessage(message: string | null): string {
  const body = message ? `<Message>${escapeXml(message)}</Message>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`;
}

export interface WhatsAppIngestOutcome {
  knownSender: boolean;
  received: number;
  unsupported: number;
  failed: number;
}

/** Hebrew reply text for the WhatsApp sender. */
export function whatsappReplyText(outcome: WhatsAppIngestOutcome): string {
  if (!outcome.knownSender) {
    return 'המספר שלך אינו מקושר ללקוח במערכת. יש לפנות למשרד הנהלת החשבונות כדי לרשום אותו.';
  }
  const { received, unsupported, failed } = outcome;
  if (received === 0 && unsupported === 0 && failed === 0) {
    return 'לא נמצא קובץ מצורף. שלחו צילום או קובץ PDF של החשבונית.';
  }

  const parts: string[] = [];
  if (received === 1) parts.push('התקבל מסמך אחד ונשלח לעיבוד.');
  else if (received > 1) parts.push(`התקבלו ${received} מסמכים ונשלחו לעיבוד.`);

  if (unsupported === 1) parts.push('קובץ אחד אינו נתמך - ניתן לשלוח PDF או תמונה (JPG/PNG).');
  else if (unsupported > 1) parts.push(`${unsupported} קבצים אינם נתמכים - ניתן לשלוח PDF או תמונה (JPG/PNG).`);

  if (failed === 1) parts.push('קליטת קובץ אחד נכשלה, נסו לשלוח אותו שוב.');
  else if (failed > 1) parts.push(`קליטת ${failed} קבצים נכשלה, נסו לשלוח אותם שוב.`);

  if (received > 0) parts.push('תודה!');
  return parts.join(' ');
}

// ── Phones ────────────────────────────────────────────────────────────────────

// Browser-safe (no crypto), so the clients page can import them directly.
export { formatPhoneForDisplay, normalizePhone } from '@/lib/phone';

// ── Email aliases ─────────────────────────────────────────────────────────────

const ALIAS_PATTERN = /^[a-z0-9][a-z0-9-]{2,62}$/;

/** New random alias like "inv-3f9a1b2c7d4e" (48 bits, unguessable - it doubles as a weak secret). */
export function generateInboundAlias(): string {
  return `inv-${randomBytes(6).toString('hex')}`;
}

export function isValidInboundAlias(alias: string): boolean {
  return ALIAS_PATTERN.test(alias);
}

/** Extracts bare addresses from "Name <a@b.com>, c@d.com" style headers. */
export function parseEmailAddresses(value: string | string[] | null | undefined): string[] {
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const matches = item.match(/[^\s<>,;"']+@[^\s<>,;"']+/g) ?? [];
    for (const m of matches) out.push(m.toLowerCase());
  }
  return out;
}

/**
 * Returns candidate client aliases from recipient addresses: the local part, without any
 * "+tag" sub-address, lower-cased. When `domain` is given only addresses at that domain count.
 */
export function extractInboundAliases(addresses: string[], domain?: string | null): string[] {
  const wantedDomain = domain?.trim().toLowerCase().replace(/^@/, '') || null;
  const aliases: string[] = [];
  for (const address of addresses) {
    const at = address.lastIndexOf('@');
    if (at <= 0) continue;
    const local = address.substring(0, at).toLowerCase();
    const host = address.substring(at + 1).toLowerCase();
    if (wantedDomain && host !== wantedDomain) continue;
    const alias = local.split('+')[0];
    if (isValidInboundAlias(alias) && !aliases.includes(alias)) aliases.push(alias);
  }
  return aliases;
}

export function inboundEmailAddress(alias: string, domain: string): string {
  return `${alias}@${domain.trim().replace(/^@/, '')}`;
}

// ── Inbound email payloads ────────────────────────────────────────────────────

export interface InboundEmailAttachment {
  filename: string;
  contentType: string;
  contentBase64: string;
}

export interface InboundEmail {
  recipients: string[];
  from: string | null;
  subject: string | null;
  messageId: string | null;
  attachments: InboundEmailAttachment[];
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function addressesFromFull(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (entry && typeof entry === 'object' ? asString((entry as Record<string, unknown>).Email) : null))
    .filter((e): e is string => !!e)
    .map((e) => e.toLowerCase());
}

/**
 * Accepts either the provider-agnostic body
 *   { to, cc?, from, subject, messageId?, attachments: [{ filename, contentType, contentBase64 }] }
 * or Postmark's inbound webhook JSON (ToFull / OriginalRecipient / Attachments[{Name, ContentType, Content}]).
 * Returns null when the body doesn't look like either.
 */
export function normalizeInboundEmail(body: unknown): InboundEmail | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;

  // Postmark inbound
  if (Array.isArray(b.Attachments) || 'ToFull' in b || 'OriginalRecipient' in b) {
    const recipients = [
      ...parseEmailAddresses(asString(b.OriginalRecipient)),
      ...addressesFromFull(b.ToFull),
      ...addressesFromFull(b.CcFull),
      ...addressesFromFull(b.BccFull),
      ...parseEmailAddresses(asString(b.To)),
    ];
    const attachments = (Array.isArray(b.Attachments) ? b.Attachments : [])
      .filter((a): a is Record<string, unknown> => !!a && typeof a === 'object')
      .map((a) => ({
        filename: asString(a.Name) ?? 'attachment',
        contentType: asString(a.ContentType) ?? '',
        contentBase64: asString(a.Content) ?? '',
      }));
    return {
      recipients: Array.from(new Set(recipients)),
      from: asString(b.From) ?? asString((b.FromFull as Record<string, unknown> | undefined)?.Email),
      subject: asString(b.Subject),
      messageId: asString(b.MessageID),
      attachments,
    };
  }

  // Generic shape
  if (!('to' in b) || !Array.isArray(b.attachments)) return null;
  const toValue = b.to as string | string[] | undefined;
  const ccValue = b.cc as string | string[] | undefined;
  const attachments = (b.attachments as unknown[])
    .filter((a): a is Record<string, unknown> => !!a && typeof a === 'object')
    .map((a) => ({
      filename: asString(a.filename) ?? 'attachment',
      contentType: asString(a.contentType) ?? '',
      contentBase64: asString(a.contentBase64) ?? '',
    }));
  return {
    recipients: Array.from(new Set([...parseEmailAddresses(toValue), ...parseEmailAddresses(ccValue)])),
    from: asString(b.from),
    subject: asString(b.subject),
    messageId: asString(b.messageId),
    attachments,
  };
}

/** Exact decoded size of a base64 string, without decoding it. */
export function base64DecodedLength(b64: string): number {
  const clean = b64.replace(/[\r\n\s]/g, '');
  if (!clean) return 0;
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  return Math.floor((clean.length * 3) / 4) - padding;
}
