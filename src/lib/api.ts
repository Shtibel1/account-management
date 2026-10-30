import type { BankTransaction, ClientContact, ClientNotification, ExtractedData, Invoice, NormalizedBankRow, SupplierAutomation, SupplierAutomationStatus, ValidationResult } from '@/shared/types';
import type { FeatureFlag, FeatureFlagsResponse, OrgFeatureFlagsResponse } from '@/shared/featureFlags';
import type { NotificationOutcome, ReturnReasonCode } from '@/shared/returns';
import type { BankAction, BankLinesPage, BankOverview, ImportResult, MatchRunResult } from '@/lib/bankTransactions';
import { MAX_BANK_PAGE_SIZE, type BankListQuery } from '@/shared/bankOverview';

const API_URL = process.env.NEXT_PUBLIC_API_URL || '';

export async function uploadInvoices(clientId: string, files: File[]) {
  const uploadedFiles: { filePath: string; fileName: string; mimeType: string }[] = [];
  const results: { fileName: string; status: 'success' | 'error'; id?: string; error?: string }[] = [];

  for (const file of files) {
    try {
      // 1. Get presigned upload URL
      const urlRes = await fetch(`${API_URL}/api/invoices/upload-url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId, fileName: file.name, mimeType: file.type }),
      });
      if (!urlRes.ok) {
        throw new Error(`Failed to get upload URL: ${await urlRes.text()}`);
      }
      const { signedUrl, filePath } = await urlRes.json();

      // 2. Upload file directly to Supabase Storage via PUT
      const uploadRes = await fetch(signedUrl, {
        method: 'PUT',
        body: file,
        headers: {
          'Content-Type': file.type,
        },
      });
      if (!uploadRes.ok) {
        throw new Error(`Failed to upload to storage: ${uploadRes.statusText}`);
      }

      uploadedFiles.push({
        filePath,
        fileName: file.name,
        mimeType: file.type,
      });
    } catch (err: any) {
      console.error(`Error uploading ${file.name}:`, err);
      results.push({
        fileName: file.name,
        status: 'error',
        error: err.message || String(err),
      });
    }
  }

  // If none of the files succeeded, return the errors immediately
  if (uploadedFiles.length === 0) {
    return { results, count: results.length };
  }

  // 3. Call server to process the uploaded files
  try {
    const res = await fetch(`${API_URL}/api/invoices/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId,
        files: uploadedFiles,
      }),
    });
    if (!res.ok) {
      throw new Error(await res.text());
    }
    const serverResponse = await res.json();
    
    // 4. Initiate client-side asynchronous dispatch to trigger pipeline processing
    if (serverResponse.results && Array.isArray(serverResponse.results)) {
      for (const result of serverResponse.results) {
        if (result.status === 'success' && result.id && result.fileUrl) {
          const uf = uploadedFiles.find((f) => f.fileName === result.fileName);
          const mimeType = uf ? uf.mimeType : 'application/pdf';

          // Trigger processing asynchronously (fire-and-forget)
          fetch(`${API_URL}/api/invoices/${result.id}/process`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              fileUrl: result.fileUrl,
              mimeType,
              tenantId: clientId,
            }),
          }).catch((err) => {
            console.error(`[Frontend API] Failed to trigger processing for invoice ${result.id}:`, err);
          });
        }
      }
    }

    // Combine results
    const combinedResults = [...results, ...(serverResponse.results || [])];
    return {
      results: combinedResults,
      count: combinedResults.length,
    };
  } catch (err: any) {
    const failedResults = [
      ...results,
      ...uploadedFiles.map((uf) => ({
        fileName: uf.fileName,
        status: 'error' as const,
        error: `Server failed to start processing: ${err.message || String(err)}`,
      })),
    ];
    return { results: failedResults, count: failedResults.length };
  }
}

export async function approveInvoice(id: string, validatedData: Partial<ExtractedData>) {
  const res = await fetch(`${API_URL}/api/invoices/${id}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ validated_data: validatedData }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
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

  const data = await res.json();

  // Trigger background process for each split part
  if (data.invoices && Array.isArray(data.invoices)) {
    for (const inv of data.invoices) {
      fetch(`${API_URL}/api/invoices/${inv.id}/process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileUrl: inv.fileUrl,
          mimeType: inv.mimeType || 'application/pdf',
          tenantId,
        }),
      }).catch((err) => {
        console.error(`[Frontend API] Failed to trigger processing for split invoice ${inv.id}:`, err);
      });
    }
  }

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
