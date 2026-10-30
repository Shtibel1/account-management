/**
 * Redaction + truncation for integration logs. Pure functions (unit-tested).
 *
 * What is redacted:
 *   - auth-ish headers (Authorization, Cookie, X-Api-Key, ...);
 *   - object keys that look like secrets (password, token, api_key, client_secret, ...), at any depth,
 *     including inside arrays;
 *   - the plugin's configured secret field names (configFields with secret: true);
 *   - any occurrence of a known secret VALUE inside any string (so a token echoed in an error message
 *     or embedded in a URL is still removed);
 *   - URL query parameters with secret-looking names.
 */

export const REDACTED = '[REDACTED]';

/** Default size limit for stored request / response bodies. */
export const MAX_LOG_BODY_BYTES = 20 * 1024;

const SECRET_HEADER_NAMES = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'api-key',
  'apikey',
  'x-auth-token',
  'x-access-token',
  'x-signature',
  'x-hub-signature',
  'x-hub-signature-256',
  'x-client-secret',
]);

/** Normalized (lowercase, no "-" / "_") key names treated as secrets. */
const SECRET_KEY_NAMES = new Set([
  'password',
  'passwd',
  'pwd',
  'secret',
  'clientsecret',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'authtoken',
  'bearertoken',
  'apikey',
  'apitoken',
  'apisecret',
  'privatekey',
  'authorization',
  'auth',
  'signingsecret',
  'webhooksecret',
  'sessionid',
  'cookie',
  'credentials',
]);

const SECRET_KEY_SUFFIXES = ['password', 'secret', 'token', 'apikey', 'privatekey'];

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_\s.]/g, '');
}

export interface RedactionOptions {
  /** Extra key names to redact (e.g. the plugin's secret config field names). */
  secretKeys?: readonly string[];
  /** Secret values to scrub from every string (e.g. the decrypted secret config values). */
  secretValues?: readonly string[];
}

export function isSecretKey(key: string, extraKeys: readonly string[] = []): boolean {
  const n = normalizeKey(key);
  if (SECRET_KEY_NAMES.has(n)) return true;
  if (SECRET_KEY_SUFFIXES.some((s) => n.endsWith(s))) return true;
  return extraKeys.some((k) => normalizeKey(k) === n);
}

export function isSecretHeader(name: string, extraKeys: readonly string[] = []): boolean {
  return SECRET_HEADER_NAMES.has(name.toLowerCase()) || isSecretKey(name, extraKeys);
}

/** Values shorter than this are not scrubbed by value (too likely to hit innocent text). */
const MIN_SCRUB_VALUE_LENGTH = 6;

function usableSecretValues(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).filter((v) => typeof v === 'string' && v.length >= MIN_SCRUB_VALUE_LENGTH))]
    .sort((a, b) => b.length - a.length);
}

/** Replaces every occurrence of a known secret value (and its URL-encoded form) inside a string. */
export function scrubString(text: string, secretValues: readonly string[] | undefined): string {
  let out = text;
  for (const value of usableSecretValues(secretValues)) {
    out = out.split(value).join(REDACTED);
    const encoded = encodeURIComponent(value);
    if (encoded !== value) out = out.split(encoded).join(REDACTED);
  }
  return out;
}

/** Strings at least this long that are pure base64 (an attached file) are summarized, not logged. */
export const LARGE_BASE64_MIN_CHARS = 1024;

/** True for an attached-file style base64 string (no whitespace, base64 alphabet only, long). */
export function isLargeBase64(text: string): boolean {
  return text.length >= LARGE_BASE64_MIN_CHARS && /^[A-Za-z0-9+/]+={0,2}$/.test(text);
}

/** Deep copy of `value` with secret keys and secret values redacted, and attached files
 * (long base64 strings) summarized as "[base64 N chars]". Handles cycles. */
export function redactDeep(value: unknown, options: RedactionOptions = {}): unknown {
  const extraKeys = options.secretKeys ?? [];
  const values = usableSecretValues(options.secretValues);
  const seen = new WeakSet<object>();

  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      if (isLargeBase64(v)) return `[base64 ${v.length} chars]`;
      return values.length ? scrubString(v, values) : v;
    }
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v)) return '[Circular]';
    seen.add(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v instanceof Date) return v.toISOString();
    const out: Record<string, unknown> = {};
    for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
      out[k] = isSecretKey(k, extraKeys) && child !== null && child !== undefined && child !== '' ? REDACTED : walk(child);
    }
    return out;
  };

  return walk(value);
}

export type HeaderInput = Headers | Record<string, string | string[] | undefined> | [string, string][] | undefined;

function headerEntries(headers: HeaderInput): [string, string][] {
  if (!headers) return [];
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    const out: [string, string][] = [];
    headers.forEach((value, key) => out.push([key, value]));
    return out;
  }
  if (Array.isArray(headers)) return headers.map(([k, v]) => [k, String(v)]);
  return Object.entries(headers)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v)]);
}

/** Headers as a plain object with secret headers redacted (names lowercased). */
export function redactHeaders(headers: HeaderInput, options: RedactionOptions = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of headerEntries(headers)) {
    const key = name.toLowerCase();
    out[key] = isSecretHeader(key, options.secretKeys) ? REDACTED : scrubString(value, options.secretValues);
  }
  return out;
}

/** URL with userinfo and secret-looking query parameters redacted, and known secret values scrubbed. */
export function redactUrl(rawUrl: string, options: RedactionOptions = {}): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return scrubString(rawUrl, options.secretValues);
  }
  if (url.username) url.username = REDACTED;
  if (url.password) url.password = REDACTED;
  const keys = [...url.searchParams.keys()];
  for (const key of new Set(keys)) {
    if (isSecretKey(key, options.secretKeys) || ['key', 'sig', 'signature', 'code'].includes(key.toLowerCase())) {
      url.searchParams.set(key, REDACTED);
    }
  }
  // URLSearchParams encodes "[REDACTED]" as %5BREDACTED%5D; keep it readable.
  return scrubString(url.toString().replace(/%5BREDACTED%5D/g, REDACTED), options.secretValues);
}

/** Truncates a string to at most `maxBytes` UTF-8 bytes (without splitting a character). */
export function truncateUtf8(text: string, maxBytes: number = MAX_LOG_BODY_BYTES): string {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= maxBytes) return text;
  const marker = `…[truncated ${bytes - maxBytes} bytes]`;
  const budget = Math.max(0, maxBytes - Buffer.byteLength(marker, 'utf8'));
  let buf = Buffer.from(text, 'utf8').subarray(0, budget);
  // Drop a trailing partial multi-byte sequence.
  let text2 = buf.toString('utf8');
  while (text2.endsWith('�') && buf.length > 0) {
    buf = buf.subarray(0, buf.length - 1);
    text2 = buf.toString('utf8');
  }
  return text2 + marker;
}

/**
 * Serializes a request / response body for the log: JSON bodies are parsed and redacted deeply, other
 * text is scrubbed of secret values; binary bodies are summarized. Result is truncated to maxBytes.
 */
export function bodyForLog(
  body: unknown,
  options: RedactionOptions = {},
  maxBytes: number = MAX_LOG_BODY_BYTES
): string | null {
  if (body === undefined || body === null || body === '') return null;
  let text: string;
  if (typeof body === 'string') {
    const trimmed = body.trim();
    if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && trimmed.length > 1) {
      try {
        text = JSON.stringify(redactDeep(JSON.parse(trimmed), options));
      } catch {
        text = scrubString(body, options.secretValues);
      }
    } else if (/^[^=&\s]+=[^&]*(&[^=&\s]+=[^&]*)*$/.test(trimmed)) {
      // application/x-www-form-urlencoded
      const params = new URLSearchParams(trimmed);
      const obj: Record<string, string> = {};
      params.forEach((v, k) => { obj[k] = v; });
      text = new URLSearchParams(redactDeep(obj, options) as Record<string, string>).toString().replace(/%5BREDACTED%5D/g, REDACTED);
    } else {
      text = scrubString(body, options.secretValues);
    }
  } else if (body instanceof Uint8Array || body instanceof ArrayBuffer) {
    const size = body instanceof ArrayBuffer ? body.byteLength : body.length;
    text = `[binary ${size} bytes]`;
  } else if (typeof Blob !== 'undefined' && body instanceof Blob) {
    text = `[blob ${body.size} bytes]`;
  } else if (typeof FormData !== 'undefined' && body instanceof FormData) {
    const obj: Record<string, string> = {};
    body.forEach((v, k) => { obj[k] = typeof v === 'string' ? v : `[file ${v.size} bytes]`; });
    text = JSON.stringify(redactDeep(obj, options));
  } else {
    text = JSON.stringify(redactDeep(body, options));
  }
  return truncateUtf8(text, maxBytes);
}
