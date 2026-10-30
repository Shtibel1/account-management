import { createHash, randomBytes } from 'node:crypto';
import type { HttpResponse, IntegrationEnvironment, InvoiceFile, PluginContext } from '@/integrations/types';
import type { MorningExpense, MorningExpenseRequest, MorningSearchRequest } from '@/integrations/plugins/morning/mapping';

/**
 * Morning (Green Invoice) API calls. ALL of them go through ctx.http (logging, retries, redaction,
 * URL guard). OpenAPI: https://developers.morning.co/api
 *
 *   token  POST {idp}/idp/v1/oauth/token  { grant_type: client_credentials, client_id, client_secret }
 *          -> { accessToken, tokenType: "Bearer", expiresAt (unix seconds) }, valid 1h
 *   API    {api}/expenses, {api}/expenses/search                   Authorization: Bearer <accessToken>
 *   file   GET {files}/file-upload/v1/url?context=expense&data={"id","source":5,"state":"expense"}
 *          -> { url, fields, maxFileSize }: presigned S3 POST (60 s), multipart, `file` LAST -> 204
 */

export interface MorningConfig {
  clientId: string;
  clientSecret: string;
  defaultDocumentType?: '305' | '320';
  attachPdf?: 'yes' | 'no';
}

export interface MorningEndpoints {
  api: string;
  token: string;
  fileUploadUrl: string;
}

export const MORNING_ENDPOINTS: Record<IntegrationEnvironment, MorningEndpoints> = {
  production: {
    api: 'https://api.greeninvoice.co.il/api/v1',
    token: 'https://api.morning.co/idp/v1/oauth/token',
    fileUploadUrl: 'https://api.morning.co/file-upload/v1/url',
  },
  sandbox: {
    api: 'https://sandbox.d.greeninvoice.co.il/api/v1',
    token: 'https://api.sandbox.morning.dev/idp/v1/oauth/token',
    fileUploadUrl: 'https://api.sandbox.d.greeninvoice.co.il/file-upload/v1/url',
  },
};

// ── Errors ────────────────────────────────────────────────────────────────

/** A Morning API error, with Morning's errorCode and (Hebrew) message. Never contains secrets. */
export class MorningApiError extends Error {
  constructor(
    message: string,
    /** "morning_<errorCode>" / "oauth_<error>" / "http_<status>" */
    public readonly code: string,
    public readonly status: number | null,
    public readonly morningCode: string | null = null
  ) {
    super(message);
    this.name = 'MorningApiError';
  }
}

/** Known codes -> clearer Hebrew (Morning's own message is appended when it differs). */
const KNOWN_ERRORS: Record<string, string> = {
  '401': 'הגישה למורנינג נדחתה - יש להתחבר מחדש',
  '1112': 'הגעתם למכסת המסמכים החודשית בחשבון מורנינג',
  '2014': 'מפתח ה-API של מורנינג שגוי',
  '2700': 'מפתח ה-API של מורנינג אינו תקין',
  '2701': 'מפתח ה-API של מורנינג אינו פעיל',
  '3007': 'מכסת החיבורים היומית למורנינג נוצלה',
  '3301': 'סכום ההוצאה אינו תקין',
  '3306': 'מספר המסמך של ההוצאה אינו תקין',
  '3309': 'לא ניתן לסווג מסמך הכנסה של העסק כהוצאה',
  '3311': 'פרטי הספק חסרים',
};

const OAUTH_ERRORS: Record<string, string> = {
  invalid_client: 'מזהה או סוד ה-API של מורנינג שגויים',
  invalid_request: 'בקשת ההתחברות למורנינג אינה תקינה',
  unauthorized_client: 'מפתח ה-API אינו מורשה לגישה זו',
  invalid_grant: 'מפתח ה-API של מורנינג אינו תקף',
};

function str(v: unknown): string | null {
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

/** Turns a failed Morning response into a MorningApiError (pure). */
export function parseMorningError(res: Pick<HttpResponse, 'status' | 'body' | 'text'>, what: string): MorningApiError {
  const body = res.body && typeof res.body === 'object' ? (res.body as Record<string, unknown>) : null;
  const errorCode = str(body?.errorCode) ?? str(body?.code);
  const errorMessage = str(body?.errorMessage) ?? str(body?.message);
  const oauthError = str(body?.error);
  const oauthDescription = str(body?.error_description);

  if (errorCode) {
    const known = KNOWN_ERRORS[errorCode];
    const text = known && errorMessage && errorMessage !== known ? `${known} (${errorMessage})` : known ?? errorMessage ?? `HTTP ${res.status}`;
    return new MorningApiError(`מורנינג: שגיאה ${what} - ${text} [קוד ${errorCode}]`.slice(0, 1000), `morning_${errorCode}`, res.status, errorCode);
  }
  if (oauthError) {
    const text = OAUTH_ERRORS[oauthError] ?? oauthDescription ?? oauthError;
    return new MorningApiError(`מורנינג: שגיאה ${what} - ${text} [${oauthError}]`.slice(0, 1000), `oauth_${oauthError}`, res.status);
  }
  const known = KNOWN_ERRORS[String(res.status)];
  const plain = typeof res.body === 'string' && res.body.trim() && res.body.length < 300 && !/<[a-z]/i.test(res.body) ? res.body.trim() : null;
  return new MorningApiError(
    `מורנינג: שגיאה ${what} - ${known ?? errorMessage ?? plain ?? 'תקלה'} (HTTP ${res.status})`.slice(0, 1000),
    `http_${res.status}`,
    res.status
  );
}

// ── Token (OAuth2 client_credentials), cached per client until expiry ─────

interface CachedToken {
  accessToken: string;
  expiresAtMs: number;
}

/** Refresh this long before the token's stated expiry. */
export const TOKEN_REFRESH_MARGIN_MS = 60_000;
const DEFAULT_TOKEN_TTL_MS = 60 * 60 * 1000;

const tokenCache = new Map<string, CachedToken>();
const inflight = new Map<string, Promise<string>>();
let clock: () => number = Date.now;

/** Test hooks. */
export const morningTokenCache = {
  clear(): void { tokenCache.clear(); inflight.clear(); },
  size(): number { return tokenCache.size; },
  keys(): string[] { return [...tokenCache.keys()]; },
  setClock(fn: (() => number) | null): void { clock = fn ?? Date.now; },
};

/** Cache key: client + environment + a hash of the credentials (no secret stored in the key). */
function cacheKey(ctx: PluginContext<MorningConfig>): string {
  const credHash = createHash('sha256').update(`${ctx.config.clientId}\u0000${ctx.config.clientSecret}`).digest('hex').slice(0, 32);
  return `${ctx.clientId}:${ctx.environment}:${credHash}`;
}

function parseExpiresAt(value: unknown, now: number): number {
  const n = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof n === 'number' && Number.isFinite(n) && n > 0) {
    // Unix seconds (per spec); accept milliseconds too.
    return n > 1e12 ? n : n * 1000;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return now + DEFAULT_TOKEN_TTL_MS;
}

async function requestToken(ctx: PluginContext<MorningConfig>): Promise<CachedToken> {
  const res = await ctx.http.request<Record<string, unknown> | string>({
    operation: 'morning_token',
    method: 'POST',
    url: MORNING_ENDPOINTS[ctx.environment].token,
    json: { grant_type: 'client_credentials', client_id: ctx.config.clientId, client_secret: ctx.config.clientSecret },
    idempotent: true, // issuing a token has no side effects
  });
  if (!res.ok) throw parseMorningError(res, 'בהתחברות');
  const body = res.body && typeof res.body === 'object' ? res.body : {};
  const accessToken = str(body.accessToken) ?? str(body.access_token);
  if (!accessToken) throw new MorningApiError('מורנינג: ההתחברות נכשלה - לא התקבל טוקן', 'no_token', res.status);
  const expiresAtMs = body.expiresAt !== undefined
    ? parseExpiresAt(body.expiresAt, clock())
    : typeof body.expires_in === 'number' ? clock() + body.expires_in * 1000 : clock() + DEFAULT_TOKEN_TTL_MS;
  return { accessToken, expiresAtMs };
}

/** A valid access token (cached per client until shortly before expiry; concurrent calls share one request). */
export async function getAccessToken(ctx: PluginContext<MorningConfig>, forceRefresh = false): Promise<string> {
  const key = cacheKey(ctx);
  const cached = tokenCache.get(key);
  if (!forceRefresh && cached && cached.expiresAtMs - TOKEN_REFRESH_MARGIN_MS > clock()) return cached.accessToken;
  if (forceRefresh) tokenCache.delete(key);
  const pending = inflight.get(key);
  if (pending) return pending;
  const promise = requestToken(ctx)
    .then((token) => {
      tokenCache.set(key, token);
      return token.accessToken;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

export function invalidateAccessToken(ctx: PluginContext<MorningConfig>): void {
  tokenCache.delete(cacheKey(ctx));
}

// ── Authenticated requests ────────────────────────────────────────────────

interface AuthedRequest {
  operation: string;
  method: 'GET' | 'POST';
  url: string;
  json?: unknown;
  idempotent: boolean;
}

/**
 * Calls the API with the cached token. On 401 the token is dropped and the call repeated ONCE with a
 * fresh token (a 401 means the request was not processed, so this is safe for POST too).
 */
export async function morningRequest<T>(ctx: PluginContext<MorningConfig>, req: AuthedRequest): Promise<HttpResponse<T>> {
  for (let attempt = 0; ; attempt++) {
    const token = await getAccessToken(ctx, attempt > 0);
    const res = await ctx.http.request<T>({
      operation: req.operation,
      method: req.method,
      url: req.url,
      headers: { Authorization: `Bearer ${token}` },
      json: req.json,
      idempotent: req.idempotent,
    });
    if (res.status === 401 && attempt === 0) {
      invalidateAccessToken(ctx);
      continue;
    }
    return res;
  }
}

export async function createExpense(ctx: PluginContext<MorningConfig>, payload: MorningExpenseRequest): Promise<MorningExpense> {
  const res = await morningRequest<MorningExpense | string>(ctx, {
    operation: 'export_invoice',
    method: 'POST',
    url: `${MORNING_ENDPOINTS[ctx.environment].api}/expenses`,
    json: payload,
    // Morning has no idempotency key: a timeout / 5xx is NOT retried (the run records it as
    // uncertain and the next run checks with findExisting first).
    idempotent: false,
  });
  if (!res.ok) throw parseMorningError(res, 'ביצירת ההוצאה');
  const body = res.body && typeof res.body === 'object' ? res.body : null;
  if (!body || typeof body.id !== 'string' || !body.id) {
    throw new MorningApiError('מורנינג: ההוצאה נוצרה אך לא התקבל מזהה', 'no_id', res.status);
  }
  return body;
}

export interface MorningSearchResponse {
  total?: number;
  page?: number;
  pageSize?: number;
  pages?: number;
  items?: MorningExpense[];
}

export async function searchExpenses(
  ctx: PluginContext<MorningConfig>,
  search: MorningSearchRequest | Record<string, unknown>,
  operation = 'find_existing'
): Promise<MorningSearchResponse> {
  const res = await morningRequest<MorningSearchResponse | string>(ctx, {
    operation,
    method: 'POST',
    url: `${MORNING_ENDPOINTS[ctx.environment].api}/expenses/search`,
    json: search,
    idempotent: true, // read-only
  });
  if (!res.ok) throw parseMorningError(res, 'בחיפוש הוצאות');
  return res.body && typeof res.body === 'object' ? res.body : {};
}

// ── PDF attachment ────────────────────────────────────────────────────────

export interface MorningUploadTarget {
  url: string;
  fields: Record<string, string>;
  maxFileSize: number | null;
}

/** The presigned POST must go to Amazon S3 over https (never anywhere the response points us). */
export function isAllowedUploadUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && !url.username && !url.password &&
      (host === 'amazonaws.com' || host.endsWith('.amazonaws.com'));
  } catch {
    return false;
  }
}

export async function getUploadTarget(ctx: PluginContext<MorningConfig>, expenseId: string): Promise<MorningUploadTarget> {
  const data = JSON.stringify({ id: expenseId, source: 5, state: 'expense' });
  const url = `${MORNING_ENDPOINTS[ctx.environment].fileUploadUrl}?context=expense&data=${encodeURIComponent(data)}`;
  const res = await morningRequest<Record<string, unknown> | string>(ctx, {
    operation: 'attach_pdf_url', method: 'GET', url, idempotent: true,
  });
  if (!res.ok) throw parseMorningError(res, 'בקבלת כתובת להעלאת הקובץ');
  const body = res.body && typeof res.body === 'object' ? res.body : {};
  const target = str(body.url);
  const rawFields = body.fields && typeof body.fields === 'object' ? (body.fields as Record<string, unknown>) : null;
  if (!target || !rawFields || !isAllowedUploadUrl(target)) {
    throw new MorningApiError('מורנינג: כתובת העלאת הקובץ אינה תקינה', 'bad_upload_url', res.status);
  }
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawFields)) {
    const s = str(v);
    if (s !== null) fields[k] = s;
  }
  const max = typeof body.maxFileSize === 'number' && body.maxFileSize > 0 ? body.maxFileSize : null;
  return { url: target, fields, maxFileSize: max };
}

/** ASCII-only filename for the multipart header (Hebrew names are replaced). */
export function multipartFileName(name: string, contentType: InvoiceFile['contentType']): string {
  const ext = contentType === 'application/pdf' ? '.pdf' : contentType === 'image/png' ? '.png' : '.jpg';
  const base = name.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80);
  return `${base || 'invoice'}${ext}`;
}

/** multipart/form-data body: every presigned field in order, `file` LAST (S3 requirement). */
export function buildMultipart(fields: Record<string, string>, file: InvoiceFile, boundary?: string): { body: Uint8Array; contentType: string } {
  const b = boundary ?? `----invoicescan${randomBytes(12).toString('hex')}`;
  const chunks: Buffer[] = [];
  const quote = (s: string) => s.replace(/["\r\n]/g, '_');
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${quote(name)}"\r\n\r\n${value}\r\n`, 'utf8'));
  }
  chunks.push(Buffer.from(
    `--${b}\r\nContent-Disposition: form-data; name="file"; filename="${multipartFileName(file.fileName, file.contentType)}"\r\n` +
    `Content-Type: ${file.contentType}\r\n\r\n`, 'utf8'
  ));
  chunks.push(Buffer.from(file.bytes));
  chunks.push(Buffer.from(`\r\n--${b}--\r\n`, 'utf8'));
  return { body: new Uint8Array(Buffer.concat(chunks)), contentType: `multipart/form-data; boundary=${b}` };
}

/** Uploads the file to the presigned S3 POST (no Morning token is sent there). */
export async function uploadFile(ctx: PluginContext<MorningConfig>, target: MorningUploadTarget, file: InvoiceFile): Promise<void> {
  const { body, contentType } = buildMultipart(target.fields, file);
  const res = await ctx.http.request({
    operation: 'attach_pdf_upload',
    method: 'POST',
    url: target.url,
    headers: { 'Content-Type': contentType },
    body,
    timeoutMs: 30_000,
    idempotent: true, // same presigned key: re-uploading overwrites, no duplicate
  });
  if (!res.ok) throw new MorningApiError(`מורנינג: העלאת הקובץ נכשלה (HTTP ${res.status})`, `http_${res.status}`, res.status);
}
