import { createHash } from 'node:crypto';
import type { HttpResponse, PluginContext } from '@/integrations/types';
import type { IcountConfig, IcountExpenseBody } from '@/integrations/plugins/icount/mapping';
import { normalizeVatId } from '@/integrations/plugins/icount/mapping';

/**
 * iCount API v3 calls. Every call goes through ctx.http (logging, retries, redaction, URL guard).
 *
 *   POST https://api.icount.co.il/api/v3.php/<module>/<method>, JSON body, JSON response
 *   { status: true, ... } or { status: false, reason, error_description } (usually with HTTP 200).
 *
 * Auth: API token (Authorization: Bearer <token>), or the legacy cid + user + pass -> auth/login -> sid,
 * sent as "sid" in the body of every call. sids are cached in memory per credentials (hash key) and
 * renewed once when iCount answers with an auth error.
 */

export const ICOUNT_BASE_URL = 'https://api.icount.co.il/api/v3.php';

/** How long a login sid is reused (iCount does not document the session lifetime). */
export const SID_TTL_MS = 20 * 60 * 1000;

const AUTH_ERROR_REASONS = new Set(['auth_required', 'bad_auth', 'bad_sid', 'invalid_sid', 'session_expired', 'sid_expired', 'no_sid']);

export class IcountApiError extends Error {
  constructor(
    message: string,
    /** iCount `reason` (e.g. "expense_already_exists") or "http_<status>" / "bad_response". */
    public readonly reason: string,
    public readonly httpStatus: number | null = null
  ) {
    super(message);
    this.name = 'IcountApiError';
  }
}

interface IcountEnvelope {
  status?: unknown;
  reason?: unknown;
  error_description?: unknown;
  [key: string]: unknown;
}

const REASON_MESSAGES: Record<string, string> = {
  bad_login: 'פרטי ההתחברות ל-iCount שגויים',
  bad_auth: 'ההרשאה ל-iCount נדחתה. בדקו את הטוקן',
  auth_required: 'נדרשת הזדהות ל-iCount. בדקו את הטוקן / פרטי ההתחברות',
  not_allowed: 'למשתמש אין הרשאה לפעולה זו ב-iCount',
  missing_supplier_id: 'חסר ספק',
  missing_expense_type_id: 'חסר סוג הוצאה',
  missing_expense_sum: 'חסר סכום',
  create_expense_failed: 'iCount לא הצליח ליצור את ההוצאה',
  create_supplier_failed: 'iCount לא הצליח ליצור את הספק',
};

function describeError(method: string, reason: string, description: unknown): string {
  const known = REASON_MESSAGES[reason];
  const desc = typeof description === 'string' && description.trim() ? description.trim().slice(0, 300) : '';
  return `iCount ${method}: ${known ?? 'שגיאה'} (${reason})${desc ? ` - ${desc}` : ''}`;
}

/** Parses an iCount response; throws IcountApiError on HTTP errors and { status: false }. */
export function parseIcountResponse<T extends object>(method: string, res: HttpResponse<unknown>): T & IcountEnvelope {
  let body: unknown = res.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(res.text); } catch { body = null; }
  }
  const env = body && typeof body === 'object' && !Array.isArray(body) ? (body as IcountEnvelope) : null;
  if (!res.ok) {
    const reason = env && typeof env.reason === 'string' ? env.reason : `http_${res.status}`;
    throw new IcountApiError(`iCount ${method}: HTTP ${res.status}${env?.reason ? ` (${String(env.reason)})` : ''}`, reason, res.status);
  }
  if (!env) throw new IcountApiError(`iCount ${method}: תשובה לא צפויה מהשרת`, 'bad_response', res.status);
  if (env.status !== true) {
    const reason = typeof env.reason === 'string' && env.reason ? env.reason : 'unknown_error';
    throw new IcountApiError(describeError(method, reason, env.error_description), reason, res.status);
  }
  return env as T & IcountEnvelope;
}

// ── sid cache (login mode) ────────────────────────────────────────────────

interface CachedSid { sid: string; expiresAt: number }
const sidCache = new Map<string, CachedSid>();
const sidInFlight = new Map<string, Promise<string>>();

/** Cache key: a hash of the credentials (the cache never holds the password itself). */
export function sidCacheKey(config: IcountConfig): string {
  return createHash('sha256').update(`${config.cid ?? ''}\u0000${config.user ?? ''}\u0000${config.pass ?? ''}`).digest('hex');
}

/** Tests only. */
export function clearIcountSidCache(): void {
  sidCache.clear();
  sidInFlight.clear();
}

let clock: () => number = Date.now;
/** Tests only. */
export function setIcountClock(now: (() => number) | null): void {
  clock = now ?? Date.now;
}

function authMode(config: IcountConfig): 'token' | 'login' {
  return config.authMode === 'login' ? 'login' : 'token';
}

async function login(ctx: PluginContext<IcountConfig>): Promise<string> {
  const { cid, user, pass } = ctx.config;
  if (!cid || !user || !pass) throw new IcountApiError('חסרים מזהה חברה / שם משתמש / סיסמה ל-iCount', 'missing_credentials');
  const res = await ctx.http.request({
    operation: 'auth_login',
    method: 'POST',
    url: `${ICOUNT_BASE_URL}/auth/login`,
    json: { cid, user, pass },
    idempotent: true, // opening a session has no side effects
  });
  const out = parseIcountResponse<{ sid?: unknown }>('auth/login', res);
  if (typeof out.sid !== 'string' || !out.sid) throw new IcountApiError('iCount auth/login: לא התקבל מזהה חיבור', 'bad_response');
  return out.sid;
}

async function getSid(ctx: PluginContext<IcountConfig>, forceRenew: boolean): Promise<string> {
  const key = sidCacheKey(ctx.config);
  const cached = sidCache.get(key);
  if (!forceRenew && cached && cached.expiresAt > clock()) return cached.sid;
  if (forceRenew) sidCache.delete(key);
  const pending = sidInFlight.get(key);
  if (pending) return pending;
  const p = login(ctx)
    .then((sid) => {
      sidCache.set(key, { sid, expiresAt: clock() + SID_TTL_MS });
      return sid;
    })
    .finally(() => sidInFlight.delete(key));
  sidInFlight.set(key, p);
  return p;
}

export interface CallOptions {
  operation: string;
  /** Reads (get_list / search / doctypes) may be retried on 5xx / timeouts; writes may not. */
  write: boolean;
}

/** One authenticated iCount call: `path` = "<module>/<method>". */
export async function icountCall<T extends object>(
  ctx: PluginContext<IcountConfig>,
  path: string,
  params: Record<string, unknown>,
  options: CallOptions
): Promise<T & IcountEnvelope> {
  const mode = authMode(ctx.config);
  if (mode === 'token' && !ctx.config.apiToken) throw new IcountApiError('חסר טוקן API של iCount', 'missing_credentials');

  const send = async (renewSid: boolean) => {
    const headers: Record<string, string> = {};
    let json: Record<string, unknown> = params;
    if (mode === 'token') headers.Authorization = `Bearer ${ctx.config.apiToken}`;
    else json = { ...params, sid: await getSid(ctx, renewSid) };
    const res = await ctx.http.request({
      operation: options.operation,
      method: 'POST',
      url: `${ICOUNT_BASE_URL}/${path}`,
      headers,
      json,
      idempotent: !options.write,
    });
    return parseIcountResponse<T>(path, res);
  };

  try {
    return await send(false);
  } catch (err) {
    // Expired / invalid sid: log in again once. An auth rejection means nothing was processed, so
    // repeating a write is safe here.
    if (mode === 'login' && err instanceof IcountApiError && AUTH_ERROR_REASONS.has(err.reason)) {
      return send(true);
    }
    throw err;
  }
}

// ── Operations ────────────────────────────────────────────────────────────

export interface IcountSupplier {
  supplier_id: number;
  supplier_name: string;
  vat_id: string | null;
}

function listOf(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter((v) => v && typeof v === 'object') as Record<string, unknown>[];
  if (value && typeof value === 'object') return Object.values(value).filter((v) => v && typeof v === 'object') as Record<string, unknown>[];
  return [];
}

function toInt(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function toSupplier(row: Record<string, unknown>): IcountSupplier | null {
  const id = toInt(row.supplier_id);
  if (id === null) return null;
  const name = typeof row.supplier_name === 'string' ? row.supplier_name : typeof row.company_name === 'string' ? row.company_name : '';
  return { supplier_id: id, supplier_name: name, vat_id: normalizeVatId(row.vat_id as string | number | null | undefined) };
}

export async function getSuppliers(ctx: PluginContext<IcountConfig>, filter: Record<string, unknown>, operation = 'supplier_lookup'): Promise<IcountSupplier[]> {
  const out = await icountCall<{ suppliers?: unknown }>(ctx, 'supplier/get_list', { ...filter, list_type: 'array', detail_level: 1 }, { operation, write: false });
  return listOf(out.suppliers).map(toSupplier).filter((s): s is IcountSupplier => s !== null);
}

const sameName = (a: string, b: string) => a.trim().replace(/\s+/g, ' ') === b.trim().replace(/\s+/g, ' ');

/** Looks the supplier up by vat_id (exact, normalized), else by exact name. */
export async function findSupplier(ctx: PluginContext<IcountConfig>, supplier: { name: string | null; vat_id: string | null }): Promise<number | null> {
  if (supplier.vat_id) {
    const list = await getSuppliers(ctx, { vat_id: supplier.vat_id });
    const hit = list.find((s) => s.vat_id === supplier.vat_id);
    if (hit) return hit.supplier_id;
    return null; // a different supplier with the same name is not this one
  }
  if (supplier.name) {
    const list = await getSuppliers(ctx, { supplier_name: supplier.name });
    const hit = list.find((s) => sameName(s.supplier_name, supplier.name!));
    if (hit) return hit.supplier_id;
  }
  return null;
}

/**
 * Existing supplier id, else creates it (supplier/add with supplier_name + vat_id). `knownMissing`:
 * the caller just looked it up and found nothing, so go straight to supplier/add.
 */
export async function resolveSupplier(
  ctx: PluginContext<IcountConfig>,
  supplier: { name: string | null; vat_id: string | null },
  knownMissing = false
): Promise<number> {
  const found = knownMissing ? null : await findSupplier(ctx, supplier);
  if (found !== null) return found;
  const params: Record<string, unknown> = { supplier_name: supplier.name ?? `ספק ${supplier.vat_id}` };
  if (supplier.vat_id) params.vat_id = supplier.vat_id;
  try {
    const out = await icountCall<{ supplier_id?: unknown }>(ctx, 'supplier/add', params, { operation: 'supplier_add', write: true });
    const id = toInt(out.supplier_id);
    if (id === null) throw new IcountApiError('iCount supplier/add: לא התקבל מזהה ספק', 'bad_response');
    return id;
  } catch (err) {
    // Created meanwhile (or name / vat id already taken): look it up again.
    if (err instanceof IcountApiError && (err.reason === 'duplicate_vat_id' || err.reason === 'duplicate_supplier_name')) {
      const again = await findSupplier(ctx, supplier);
      if (again !== null) return again;
      if (err.reason === 'duplicate_supplier_name' && supplier.vat_id) {
        throw new IcountApiError(`ב-iCount קיים ספק בשם "${supplier.name}" עם ח.פ. אחר. בדקו את הספק ב-iCount`, err.reason);
      }
    }
    throw err;
  }
}

/** expense/search by supplier + doctype + docnum (drafts included). Returns the expense_id or null. */
export async function findExpense(
  ctx: PluginContext<IcountConfig>,
  supplierId: number,
  doctype: string,
  docnum: string
): Promise<string | null> {
  const out = await icountCall<{ results_list?: unknown }>(ctx, 'expense/search', {
    supplier_id: supplierId,
    expense_doctype: doctype,
    expense_docnum: docnum,
    show_drafts: true,
    limit: 50,
  }, { operation: 'find_existing', write: false });
  // Filter again locally: never adopt a document that does not match exactly.
  const hit = listOf(out.results_list).find((r) =>
    String(r.expense_docnum ?? '').trim() === docnum &&
    (r.expense_doctype === undefined || String(r.expense_doctype) === doctype) &&
    (r.supplier_id === undefined || toInt(r.supplier_id) === supplierId)
  );
  const id = hit ? toInt(hit.expense_id) : null;
  return id === null ? null : String(id);
}

export async function createExpense(ctx: PluginContext<IcountConfig>, body: IcountExpenseBody & { supplier_id: number }): Promise<string> {
  const out = await icountCall<{ expense_id?: unknown }>(ctx, 'expense/create', body as unknown as Record<string, unknown>, {
    operation: 'export_invoice',
    write: true,
  });
  const id = toInt(out.expense_id);
  if (id === null) throw new IcountApiError('iCount expense/create: לא התקבל מזהה הוצאה', 'bad_response');
  return String(id);
}

export async function getDocTypes(ctx: PluginContext<IcountConfig>, operation = 'test_connection'): Promise<string[]> {
  const out = await icountCall<{ expense_doctypes?: unknown }>(ctx, 'expense/doctypes', {}, { operation, write: false });
  const value = out.expense_doctypes;
  if (Array.isArray(value)) {
    return value.map((v) => (v && typeof v === 'object' ? String((v as { doctype?: unknown }).doctype ?? '') : String(v))).filter(Boolean);
  }
  return value && typeof value === 'object' ? Object.keys(value) : [];
}

export interface IcountExpenseType { expense_type_id: number; expense_type_name: string }

export async function getExpenseTypes(ctx: PluginContext<IcountConfig>, operation = 'list_expense_types'): Promise<IcountExpenseType[]> {
  const out = await icountCall<{ expense_types?: unknown }>(ctx, 'expense_type/get_list', { list_type: 'array' }, { operation, write: false });
  return listOf(out.expense_types)
    .map((r) => ({ expense_type_id: toInt(r.expense_type_id), expense_type_name: String(r.expense_type_name ?? '') }))
    .filter((t): t is IcountExpenseType => t.expense_type_id !== null);
}
