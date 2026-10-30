import type { HttpResponse, PluginContext } from '@/integrations/types';
import {
  EXPENSE_DOCUMENT_TYPES,
  SUMIT_BASE_URL,
  type SumitConfig,
  type SumitExpensePayload,
  type SumitListedDocument,
} from '@/integrations/plugins/sumit/mapping';

/**
 * SUMIT API calls - ONLY through ctx.http (logging, retries, redaction, URL guard).
 *
 * Auth: SUMIT has no tokens / sessions. Every request carries Credentials { CompanyID, APIKey } in
 * its JSON body (no Authorization header), so there is nothing to obtain or cache. The APIKey config
 * field is secret: its key and value are redacted from every log row / console line.
 *
 * Every endpoint is a POST answering HTTP 200 with the envelope
 *   { Status: 0 Success | 1 BusinessError | 2 TechnicalError, UserErrorMessage, TechnicalErrorDetails, Data }.
 */

export const SUMIT_PATHS = {
  addExpense: '/accounting/documents/addexpense/',
  listDocuments: '/accounting/documents/list/',
  vatRate: '/accounting/general/getvatrate/',
} as const;

const LIST_PAGE_SIZE = 1000;
/** Upper bound for the duplicate lookup (pages of LIST_PAGE_SIZE expense documents within +-1 day). */
const MAX_LIST_PAGES = 5;

export type SumitStatus = 'success' | 'business_error' | 'technical_error';

export interface SumitEnvelope<T> {
  Status?: unknown;
  UserErrorMessage?: string | null;
  TechnicalErrorDetails?: string | null;
  Data?: T | null;
}

export class SumitApiError extends Error {
  constructor(
    message: string,
    /** 'business' = SUMIT rejected the request (validation, credentials), 'technical' = SUMIT-side
     * error, 'http' = non-200, 'invalid_response' = not the documented envelope. */
    public readonly kind: 'business' | 'technical' | 'http' | 'invalid_response',
    public readonly status: number | null = null
  ) {
    super(message);
    this.name = 'SumitApiError';
  }
}

/** Status as a number (0/1/2) or a name ("Success", "BusinessError", "Success (0)"). */
export function sumitStatusOf(value: unknown): SumitStatus | null {
  if (value === 0 || value === '0') return 'success';
  if (value === 1 || value === '1') return 'business_error';
  if (value === 2 || value === '2') return 'technical_error';
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v.startsWith('success')) return 'success';
    if (v.startsWith('businesserror')) return 'business_error';
    if (v.startsWith('technicalerror')) return 'technical_error';
  }
  return null;
}

function clip(text: string, max = 500): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Parses a SUMIT response (the spec also allows text/plain, so a string body is JSON-parsed here).
 * Returns Data on Success, throws SumitApiError otherwise.
 */
export function parseSumitResponse<T>(res: HttpResponse<unknown>): T {
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw new SumitApiError(`SUMIT דחה את הבקשה (HTTP ${res.status})`, 'http', res.status);
    throw new SumitApiError(`SUMIT החזיר HTTP ${res.status}`, 'http', res.status);
  }
  let body: unknown = res.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      throw new SumitApiError('תשובה לא צפויה מ-SUMIT', 'invalid_response', res.status);
    }
  }
  if (!body || typeof body !== 'object') throw new SumitApiError('תשובה לא צפויה מ-SUMIT', 'invalid_response', res.status);
  const env = body as SumitEnvelope<T>;
  const status = sumitStatusOf(env.Status);
  if (status === 'success') return (env.Data ?? null) as T;
  const userMessage = typeof env.UserErrorMessage === 'string' && env.UserErrorMessage.trim()
    ? clip(env.UserErrorMessage.trim())
    : null;
  if (status === 'business_error') {
    throw new SumitApiError(`SUMIT דחה את הבקשה: ${userMessage ?? 'שגיאה עסקית'}`, 'business', res.status);
  }
  if (status === 'technical_error') {
    // TechnicalErrorDetails stays in the (redacted) response log only, not in the user message.
    throw new SumitApiError(`שגיאה טכנית ב-SUMIT${userMessage ? `: ${userMessage}` : ''}`, 'technical', res.status);
  }
  throw new SumitApiError('תשובה לא צפויה מ-SUMIT', 'invalid_response', res.status);
}

export function sumitCredentials(config: SumitConfig): { CompanyID: number; APIKey: string } {
  return { CompanyID: Number(config.companyId), APIKey: config.apiKey };
}

function call(
  ctx: PluginContext<SumitConfig>,
  operation: string,
  path: string,
  body: Record<string, unknown>,
  options: { idempotent: boolean; timeoutMs?: number; invoiceId?: string | null }
): Promise<HttpResponse<unknown>> {
  return ctx.http.request({
    operation,
    method: 'POST',
    url: `${SUMIT_BASE_URL}${path}`,
    headers: { 'Content-Language': 'he' },
    json: { Credentials: sumitCredentials(ctx.config), ...body },
    // Read-only calls (list / getvatrate) are safe to repeat; addexpense is not (no idempotency key).
    idempotent: options.idempotent,
    timeoutMs: options.timeoutMs,
    ...(options.invoiceId !== undefined ? { invoiceId: options.invoiceId } : {}),
  });
}

/** Read-only call used by "בדוק חיבור": checks the credentials and returns the VAT rate. */
export async function getVatRate(ctx: PluginContext<SumitConfig>): Promise<number | null> {
  const res = await call(ctx, 'test_connection', SUMIT_PATHS.vatRate, {}, { idempotent: true, invoiceId: null });
  const data = parseSumitResponse<{ Rate?: unknown } | null>(res);
  return typeof data?.Rate === 'number' ? data.Rate : null;
}

/** Creates the expense. NOT idempotent: a 5xx / timeout is not retried (the run records it uncertain). */
export async function addExpense(ctx: PluginContext<SumitConfig>, payload: SumitExpensePayload): Promise<number> {
  const res = await call(ctx, 'export_invoice', SUMIT_PATHS.addExpense, { ...payload }, { idempotent: false, timeoutMs: 60_000 });
  const data = parseSumitResponse<{ DocumentID?: unknown } | null>(res);
  const id = data?.DocumentID;
  if (typeof id !== 'number' || !Number.isFinite(id) || id <= 0) {
    throw new SumitApiError('SUMIT לא החזיר מזהה מסמך', 'invalid_response', res.status);
  }
  return id;
}

/** Expense documents (incl. drafts) dated within [from, to], all pages up to MAX_LIST_PAGES. */
export async function listExpenseDocuments(
  ctx: PluginContext<SumitConfig>,
  window: { from: string; to: string }
): Promise<SumitListedDocument[]> {
  const docs: SumitListedDocument[] = [];
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const res = await call(ctx, 'find_existing', SUMIT_PATHS.listDocuments, {
      DocumentTypes: [...EXPENSE_DOCUMENT_TYPES],
      DateFrom: window.from,
      DateTo: window.to,
      IncludeDrafts: true,
      Paging: { StartIndex: page * LIST_PAGE_SIZE, PageSize: LIST_PAGE_SIZE },
    }, { idempotent: true, timeoutMs: 30_000 });
    const data = parseSumitResponse<{ Documents?: unknown; HasNextPage?: unknown } | null>(res);
    const pageDocs = Array.isArray(data?.Documents) ? (data!.Documents as SumitListedDocument[]) : [];
    docs.push(...pageDocs);
    if (data?.HasNextPage !== true) return docs;
  }
  // More documents than we looked at: a "not found" would not be reliable, so do not claim it.
  throw new SumitApiError('יותר מדי מסמכי הוצאה בטווח התאריכים לבדיקת כפילות', 'invalid_response');
}
