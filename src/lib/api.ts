import type { BankTransaction, ClientContact, ClientNotification, ExtractedData, Invoice, NormalizedBankRow, SupplierAutomation, SupplierAutomationStatus, ValidationResult } from '@/shared/types';
import type { FeatureFlag, FeatureFlagsResponse, OrgFeatureFlagsResponse } from '@/shared/featureFlags';
import type { NotificationOutcome, ReturnReasonCode } from '@/shared/returns';
import type { BankAction, BankLinesPage, BankOverview, ImportResult, MatchRunResult } from '@/lib/bankTransactions';
import { mimeFromFileName } from '@/shared/uploadValidation';
import { MAX_BANK_PAGE_SIZE, type BankListQuery } from '@/shared/bankOverview';

const API_URL = process.env.NEXT_PUBLIC_API_URL || '';

export type UploadFileResult = { fileName: string; status: 'success' | 'error'; id?: string; error?: string };

async function errorText(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => null);
  return typeof body?.error === 'string' && body.error ? body.error : fallback;
}

/**
 * Uploads files for a client: signed upload URL (the server checks name / type / size first),
 * PUT to Storage, register (the server checks the stored bytes), then queue processing.
 * Every file gets its own honest result - a file the server rejected is reported as an error.
 */
export async function uploadInvoices(clientId: string, files: File[]): Promise<{ results: UploadFileResult[]; count: number }> {
  const uploadedFiles: { filePath: string; fileName: string; mimeType: string }[] = [];
  const results: UploadFileResult[] = [];

  for (const file of files) {
    try {
      // 1. Get presigned upload URL
      const urlRes = await fetch(`${API_URL}/api/invoices/upload-url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId, fileName: file.name, mimeType: file.type, size: file.size }),
      });
      if (!urlRes.ok) {
        throw new Error(await errorText(urlRes, 'לא ניתן היה להכין את העלאת הקובץ'));
      }
      const { signedUrl, filePath } = await urlRes.json();

      // 2. Upload file directly to Supabase Storage via PUT
      const uploadRes = await fetch(signedUrl, {
        method: 'PUT',
        body: file,
        headers: {
          // The type implied by the (already checked) extension: some browsers send an empty or
          // generic type, which the raw-invoices bucket (allowed_mime_types) would refuse
          'Content-Type': mimeFromFileName(file.name) ?? file.type ?? 'application/octet-stream',
        },
      });
      if (!uploadRes.ok) {
        throw new Error(uploadRes.status === 413 ? 'הקובץ גדול מ-20MB' : 'העלאת הקובץ לאחסון נכשלה');
      }

      uploadedFiles.push({
        filePath,
        fileName: file.name,
        mimeType: mimeFromFileName(file.name) ?? file.type,
      });
    } catch (err: any) {
      console.error(`Error uploading ${file.name}:`, err);
      results.push({
        fileName: file.name,
        status: 'error',
        error: err instanceof TypeError ? 'אין חיבור לשרת - יש לנסות שוב' : err?.message || 'העלאת הקובץ נכשלה',
      });
    }
  }

  // If none of the files succeeded, return the errors immediately
  if (uploadedFiles.length === 0) {
    return { results, count: results.length };
  }

  // 3. Register the stored files (the server re-checks size and content)
  let registered: UploadFileResult[];
  try {
    const res = await fetch(`${API_URL}/api/invoices/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId,
        files: uploadedFiles,
      }),
    });
    const serverResponse = await res.json().catch(() => null);
    // 422 = every file was rejected: the per-file reasons are still in results
    if (!Array.isArray(serverResponse?.results)) {
      throw new Error(typeof serverResponse?.error === 'string' ? serverResponse.error : 'רישום הקבצים נכשל');
    }
    registered = serverResponse.results;
  } catch (err: any) {
    const failedResults = [
      ...results,
      ...uploadedFiles.map((uf) => ({
        fileName: uf.fileName,
        status: 'error' as const,
        error: err?.message || 'רישום הקבצים נכשל',
      })),
    ];
    return { results: failedResults, count: failedResults.length };
  }

  // 4. Queue processing (the server answers at once; the work runs in the background)
  const queued = await Promise.all(
    registered.map(async (result): Promise<UploadFileResult> => {
      if (result.status !== 'success' || !result.id) return result;
      const uf = uploadedFiles.find((f) => f.fileName === result.fileName);
      try {
        const res = await fetch(`${API_URL}/api/invoices/${result.id}/process`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mimeType: uf?.mimeType || undefined }),
        });
        if (!res.ok) {
          return { ...result, status: 'error', error: await errorText(res, 'הקובץ נשמר אך העיבוד לא הופעל') };
        }
        return result;
      } catch (err) {
        console.error(`[Frontend API] Failed to queue processing for invoice ${result.id}:`, err);
        // The row exists; the review screen / scheduled worker will still pick it up
        return result;
      }
    })
  );

  const combinedResults = [...results, ...queued];
  return {
    results: combinedResults,
    count: combinedResults.length,
  };
}

/** Queues re-processing (review / error). An approved invoice is reopened first (reopenInvoice). */
export async function reprocessInvoice(id: string) {
  const res = await fetch(`${API_URL}/api/invoices/${encodeURIComponent(id)}/process`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error(await errorText(res, 'לא ניתן היה להפעיל עיבוד מחדש'));
  return res.json();
}

export interface ProcessingTickResponse {
  state: 'done' | 'pending' | 'busy' | 'waiting' | 'failed';
  stage?: string | null;
  progress?: { pages_done: number; pages_total: number | null } | null;
}

/** Advances an invoice's queued processing by one bounded step (called while it shows as processing). */
export async function tickProcessing(id: string): Promise<ProcessingTickResponse | null> {
  try {
    const res = await fetch(`${API_URL}/api/invoices/${encodeURIComponent(id)}/process/tick`, { method: 'POST' });
    if (!res.ok) return null;
    return (await res.json()) as ProcessingTickResponse;
  } catch {
    return null;
  }
}

export async function approveInvoice(id: string, validatedData: Partial<ExtractedData>) {
  const res = await fetch(`${API_URL}/api/invoices/${id}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ validated_data: validatedData }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error ?? 'שגיאה באישור החשבונית');
  return body;
}

async function invoiceAction(id: string, action: 'reject' | 'retry' | 'reopen', fallbackError: string, payload: Record<string, unknown> = {}) {
  const res = await fetch(`${API_URL}/api/invoices/${encodeURIComponent(id)}/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error ?? fallbackError);
  return body as { success: true; status: string };
}

/** "לא מאושרת": invoice in review, or a failed document, with an optional reason. */
export function rejectInvoice(id: string, reason?: string) {
  const trimmed = reason?.trim();
  return invoiceAction(id, 'reject', 'שגיאה בסימון החשבונית כלא מאושרת', trimmed ? { reason: trimmed } : {});
}

/** Failed document: back to processing, then (fire-and-forget) re-runs the pipeline. */
export async function retryInvoice(id: string) {
  const result = await invoiceAction(id, 'retry', 'שגיאה בהפעלת העיבוד מחדש');
  fetch(`${API_URL}/api/invoices/${encodeURIComponent(id)}/process`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  }).catch((err) => {
    console.error(`[Frontend API] Failed to trigger reprocessing for invoice ${id}:`, err);
  });
  return result;
}

/** Back to review (approved / rejected / returned; exported = office owner only, logged). */
export function reopenInvoice(id: string, reason?: string) {
  return invoiceAction(id, 'reopen', 'שגיאה בפתיחת החשבונית מחדש', reason ? { reason } : {});
}

/** Deletes a failed document (status 'error' only). */
export async function deleteInvoice(id: string): Promise<void> {
  const res = await fetch(`${API_URL}/api/invoices/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? 'שגיאה במחיקת החשבונית');
  }
}

/** Re-applies supplier rules to the client's invoices still in review. Omit suppliers to re-apply to all. */
export async function reapplySupplierRules(
  clientId: string,
  suppliers?: { name?: string | null; vatId?: string | null }[]
): Promise<{ checked: number; updated: number }> {
  const res = await fetch(`${API_URL}/api/suppliers/rules/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId, suppliers }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function fetchSupplierAutomation(
  clientId: string
): Promise<{ historySize: number; suppliers: SupplierAutomationStatus[] }> {
  const res = await fetch(`${API_URL}/api/suppliers/automation?clientId=${encodeURIComponent(clientId)}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function setSupplierAutoApprove(
  clientId: string,
  supplierVatId: string,
  autoApprove: boolean
): Promise<SupplierAutomation> {
  const res = await fetch(`${API_URL}/api/suppliers/automation`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId, supplierVatId, autoApprove }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? 'שגיאה בעדכון האישור האוטומטי');
  }
  return res.json();
}

export class MissingMappingsError extends Error {
  constructor(public readonly missing: string[]) {
    super('מיפויים חסרים');
  }
}

/**
 * Short-lived signed URL of an invoice's original file (invoices.file_url is a storage reference,
 * not a link - QA #31).
 */
export async function getInvoiceFileUrl(invoiceId: string): Promise<string> {
  const res = await fetch(`${API_URL}/api/invoices/${encodeURIComponent(invoiceId)}/file`, { cache: 'no-store' });
  const body = await res.json().catch(() => null);
  if (!res.ok || typeof body?.url !== 'string') {
    throw new Error(body?.error ?? 'לא ניתן לפתוח את קובץ החשבונית');
  }
  return body.url;
}

export async function exportInvoices(ids: string[]) {
  const res = await fetch(`${API_URL}/api/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    if (res.status === 422 && body?.missing?.length) {
      throw new MissingMappingsError(body.missing as string[]);
    }
    if (res.status === 422 && Array.isArray(body?.invalid) && body.invalid.length) {
      // Values that don't fit the Move-in format (e.g. an invoice number longer than 9 characters)
      throw new Error([body.error, ...(body.invalid as string[])].join('\n'));
    }
    throw new Error(body?.error ?? 'שגיאה בייצוא');
  }
  return res.blob();
}

export async function splitInvoice(
  id: string,
  splits: { startPage: number; endPage: number }[],
  tenantId: string
) {
  const res = await fetch(`${API_URL}/api/invoices/${id}/split`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ splits }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? 'שגיאה בפיצול הקובץ');
  }

  // The server queues every part for processing itself
  const data = await res.json();
  return data;
}

/** Marks `otherInvoiceId` as "not a duplicate" of invoice `id`; returns the invoice's updated validation flags. */
export async function dismissDuplicate(id: string, otherInvoiceId: string): Promise<ValidationResult | null> {
  const res = await fetch(`${API_URL}/api/invoices/${id}/duplicates/dismiss`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ otherInvoiceId }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error ?? 'שגיאה בסימון החשבונית כלא כפולה');
  return (body?.validation_flags ?? null) as ValidationResult | null;
}

export interface ChannelSettings {
  emailDomain: string | null;
  emailEnabled: boolean;
  whatsappEnabled: boolean;
  whatsappNumber: string | null;
}

export interface ClientChannelsInfo {
  clientId: string;
  inboundAlias: string | null;
  contacts: ClientContact[];
}

export async function fetchClientChannels(): Promise<{ settings: ChannelSettings; clients: ClientChannelsInfo[] }> {
  const res = await fetch(`${API_URL}/api/clients/channels`, { cache: 'no-store' });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? 'שגיאה בטעינת ערוצי הקליטה');
  }
  return res.json();
}

export async function addClientContact(clientId: string, phone: string, name: string): Promise<ClientContact> {
  const res = await fetch(`${API_URL}/api/clients/${clientId}/contacts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, name }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error ?? 'שגיאה בהוספת מספר');
  return body as ClientContact;
}

export async function removeClientContact(clientId: string, contactId: string): Promise<void> {
  const res = await fetch(`${API_URL}/api/clients/${clientId}/contacts/${contactId}`, { method: 'DELETE' });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? 'שגיאה במחיקת מספר');
  }
}

// ── Bank statement matching ───────────────────────────────────────────

export interface BankOverviewResponse extends BankOverview {
  /** True when the bank_transactions migration hasn't been applied to the database yet. */
  setupRequired?: boolean;
}

/** Failed bank API call; `code` is the server's machine-readable reason (e.g. 'amount_mismatch'). */
export class BankRequestError extends Error {
  constructor(message: string, public readonly status: number, public readonly code?: string) {
    super(message);
    this.name = 'BankRequestError';
  }
}

async function bankRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${url}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new BankRequestError(
      body?.error ?? 'שגיאה בתקשורת עם השרת',
      res.status,
      typeof body?.code === 'string' ? body.code : undefined
    );
  }
  return body as T;
}

function bankListParams(clientId: string, query: Partial<BankListQuery>): URLSearchParams {
  const params = new URLSearchParams({ clientId });
  if (query.mode && query.mode !== 'all') params.set('mode', query.mode);
  if (query.status && query.status !== 'all') params.set('status', query.status);
  if (query.account != null) params.set('account', query.account);
  if (query.search?.trim()) params.set('q', query.search.trim());
  if (query.page) params.set('page', String(query.page));
  if (query.pageSize) params.set('pageSize', String(query.pageSize));
  return params;
}

/** One page of lines + summary + the invoices / candidates of that page. */
export function fetchBankOverview(clientId: string, query: Partial<BankListQuery> = {}) {
  return bankRequest<BankOverviewResponse>(`/api/bank?${bankListParams(clientId, query)}`);
}

/** Every line matching the filters, fetched page by page (e.g. the full missing-invoices list). */
export async function fetchAllBankLines(
  clientId: string,
  query: Partial<Pick<BankListQuery, 'mode' | 'status' | 'account' | 'search'>>
): Promise<BankTransaction[]> {
  const lines: BankTransaction[] = [];
  for (let page = 1; ; page++) {
    const params = bankListParams(clientId, { ...query, page, pageSize: MAX_BANK_PAGE_SIZE });
    params.set('view', 'lines');
    const res = await bankRequest<BankLinesPage>(`/api/bank?${params}`);
    lines.push(...res.transactions);
    if (res.page >= res.totalPages || res.transactions.length === 0) return lines;
  }
}

export function importBankStatement(payload: {
  clientId: string;
  accountLabel: string;
  fileName: string | null;
  rows: NormalizedBankRow[];
}) {
  return bankRequest<ImportResult & MatchRunResult & { matchError?: string }>('/api/bank/import', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function runBankAutoMatch(clientId: string) {
  return bankRequest<MatchRunResult>('/api/bank/match', {
    method: 'POST',
    body: JSON.stringify({ clientId }),
  });
}

export function bankTransactionAction(id: string, action: BankAction) {
  return bankRequest<BankTransaction>(`/api/bank/transactions/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(action),
  });
}

// ── Feature flags + accountant review loop ────────────────────────────

async function jsonRequest<T>(url: string, fallbackError: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${url}`, {
    cache: 'no-store',
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error ?? fallbackError);
  return body as T;
}

export function fetchFeatureFlags(scope: { orgId?: string | null; clientId?: string | null } = {}) {
  const params = new URLSearchParams();
  if (scope.clientId) params.set('clientId', scope.clientId);
  else if (scope.orgId) params.set('orgId', scope.orgId);
  const qs = params.toString();
  return jsonRequest<FeatureFlagsResponse>(`/api/feature-flags${qs ? `?${qs}` : ''}`, 'שגיאה בטעינת התכונות');
}

export function fetchOrgFeatureFlags(orgId: string | null) {
  const qs = orgId ? `?orgId=${encodeURIComponent(orgId)}` : '';
  return jsonRequest<OrgFeatureFlagsResponse>(`/api/org/feature-flags${qs}`, 'שגיאה בטעינת התכונות');
}

/** enabled null = back to the server default. */
export function setOrgFeatureFlag(orgId: string | null, flag: FeatureFlag, enabled: boolean | null) {
  return jsonRequest<OrgFeatureFlagsResponse>('/api/org/feature-flags', 'שגיאה בשמירת התכונה', {
    method: 'PUT',
    body: JSON.stringify({ orgId, flag, enabled }),
  });
}

export function returnInvoiceToClient(id: string, reasonCode: ReturnReasonCode, note: string) {
  return jsonRequest<{ invoice: Invoice; notifications: NotificationOutcome[] }>(
    `/api/invoices/${encodeURIComponent(id)}/return`,
    'שגיאה בהחזרת החשבונית ללקוח',
    { method: 'POST', body: JSON.stringify({ reasonCode, note }) }
  );
}

export function fetchInvoiceNotifications(id: string) {
  return jsonRequest<ClientNotification[]>(`/api/invoices/${encodeURIComponent(id)}/notifications`, 'שגיאה בטעינת היסטוריית ההודעות');
}

export function fetchClientContactEmail(clientId: string) {
  return jsonRequest<{ contactEmail: string | null }>(
    `/api/clients/${encodeURIComponent(clientId)}/contact-email`,
    'שגיאה בטעינת כתובת האימייל'
  );
}

export function saveClientContactEmail(clientId: string, email: string | null) {
  return jsonRequest<{ contactEmail: string | null }>(
    `/api/clients/${encodeURIComponent(clientId)}/contact-email`,
    'שגיאה בשמירת כתובת האימייל',
    { method: 'PUT', body: JSON.stringify({ email }) }
  );
}
