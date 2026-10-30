import type {
  ClientIntegrationView,
  IntegrationEnvironment,
  IntegrationLogRecord,
  InvoiceExportRecord,
  PluginInfo,
} from '@/integrations/types';
import type { RunExportResult } from '@/integrations/exportRunner';

/** Browser-side calls for export plugins / integration settings / integration logs. */

const API_URL = process.env.NEXT_PUBLIC_API_URL || '';

export class ApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly issues: string[] = []) {
    super(message);
    this.name = 'ApiError';
  }
}

async function call<T>(path: string, init?: RequestInit, fallback = 'שגיאה בתקשורת עם השרת'): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(body?.error ?? body?.message ?? fallback, res.status, Array.isArray(body?.issues) ? body.issues : []);
  }
  return body as T;
}

export interface ClientIntegrationsResponse {
  plugins: PluginInfo[];
  integrations: ClientIntegrationView[];
  encryptionConfigured: boolean;
}

export function fetchClientIntegrations(clientId: string) {
  return call<ClientIntegrationsResponse>(`/api/clients/${encodeURIComponent(clientId)}/integrations`, undefined, 'שגיאה בטעינת הגדרות החיבור');
}

export function fetchPlugins() {
  return call<{ plugins: PluginInfo[] }>('/api/integrations/plugins');
}

export interface SaveIntegrationInput {
  enabled?: boolean;
  environment?: IntegrationEnvironment;
  /** Secrets: '' / mask = keep, null = clear. */
  config?: Record<string, unknown>;
}

export function saveClientIntegration(clientId: string, pluginId: string, input: SaveIntegrationInput) {
  return call<ClientIntegrationView>(
    `/api/clients/${encodeURIComponent(clientId)}/integrations/${encodeURIComponent(pluginId)}`,
    { method: 'PUT', body: JSON.stringify(input) },
    'שמירת ההגדרות נכשלה'
  );
}

export function deleteClientIntegration(clientId: string, pluginId: string) {
  return call<{ ok: true }>(
    `/api/clients/${encodeURIComponent(clientId)}/integrations/${encodeURIComponent(pluginId)}`,
    { method: 'DELETE' },
    'מחיקת החיבור נכשלה'
  );
}

export interface TestConnectionResponse {
  ok: boolean;
  message: string;
  correlationId?: string;
  issues?: string[];
}

export async function testClientIntegration(
  clientId: string,
  pluginId: string,
  input: { environment?: IntegrationEnvironment; config?: Record<string, unknown> }
): Promise<TestConnectionResponse> {
  const res = await fetch(
    `${API_URL}/api/clients/${encodeURIComponent(clientId)}/integrations/${encodeURIComponent(pluginId)}/test`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }
  );
  const body = await res.json().catch(() => null);
  if (body && typeof body.message === 'string') return body as TestConnectionResponse;
  return { ok: false, message: body?.error ?? 'בדיקת החיבור נכשלה' };
}

export type ExportRunResponse = RunExportResult & { environment: IntegrationEnvironment };

export function runIntegrationExport(input: { invoiceIds: string[]; pluginId: string; dryRun?: boolean; force?: boolean }) {
  return call<ExportRunResponse>('/api/integrations/export', { method: 'POST', body: JSON.stringify(input) }, 'הייצוא נכשל');
}

export type IntegrationLogListItem = Omit<IntegrationLogRecord, 'request_body' | 'response_body' | 'org_id' | 'client_id'>;

export interface LogFilters {
  pluginId?: string;
  outcome?: string;
  invoiceId?: string;
  correlationId?: string;
  before?: string | null;
  limit?: number;
}

export function fetchIntegrationLogs(clientId: string, filters: LogFilters = {}) {
  const params = new URLSearchParams({ clientId });
  for (const [k, v] of Object.entries(filters)) {
    if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
  }
  return call<{ logs: IntegrationLogListItem[]; nextBefore: string | null }>(`/api/integrations/logs?${params}`, undefined, 'שגיאה בטעינת היומן');
}

export function fetchIntegrationLog(id: string) {
  return call<IntegrationLogRecord>(`/api/integrations/logs/${encodeURIComponent(id)}`, undefined, 'שגיאה בטעינת הרשומה');
}

export function fetchInvoiceExports(clientId: string, pluginId?: string) {
  const params = new URLSearchParams({ clientId });
  if (pluginId) params.set('pluginId', pluginId);
  return call<{ exports: InvoiceExportRecord[] }>(`/api/integrations/exports?${params}`);
}

/** Triggers a browser download of a base64 file returned by a file plugin. */
export function downloadBase64File(file: { fileName: string; contentType: string; base64: string }): void {
  const bytes = Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: file.contentType }));
  const a = document.createElement('a');
  a.href = url;
  a.download = file.fileName;
  a.click();
  URL.revokeObjectURL(url);
}
