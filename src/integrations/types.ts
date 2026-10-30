import type { z } from 'zod';
import type { AccountMapping, ExtractedData, Invoice, InvoiceStatus } from '@/shared/types';

/**
 * Export plugin contract. A plugin = one bookkeeping system (or file format) an office can export
 * approved invoices to. See docs/integrations.md for how to write one.
 *
 *   src/integrations/plugins/<id>/index.ts    the ExportPlugin object (registered in registry.ts)
 *   src/integrations/plugins/<id>/mapping.ts  ExportInvoice + InvoiceMapping -> the target's payload
 *   src/integrations/plugins/<id>/client.ts   the target's API calls, ONLY through ctx.http
 */

export type PluginKind = 'api' | 'file';
export type IntegrationEnvironment = 'sandbox' | 'production';

export interface PluginCapabilities {
  /** Can attach the invoice PDF / image to the exported document. */
  attachPdf: boolean;
  /** Sends the ITA allocation number (מספר הקצאה). */
  allocationNumber: boolean;
  /** The target itself rejects / detects duplicate documents (findExisting or server-side). */
  duplicateCheck: boolean;
  /** Has a separate sandbox / test environment. */
  sandbox: boolean;
}

export type ConfigFieldType = 'text' | 'password' | 'url' | 'number' | 'select';

/** UI + redaction description of one config key. Every secret MUST be `secret: true`. */
export interface ConfigField {
  key: string;
  /** Hebrew label. */
  label: string;
  type: ConfigFieldType;
  /** Stored encrypted, shown masked, redacted (key and value) from every log. */
  secret: boolean;
  required: boolean;
  placeholder?: string;
  help?: string;
  options?: { value: string; label: string }[];
}

// ── Data handed to plugins ─────────────────────────────────────────────────

/** An approved invoice ready for export (validated_data, falling back to extracted_data). */
export interface ExportInvoice {
  id: string;
  clientId: string;
  status: InvoiceStatus;
  fileName: string;
  fileUrl: string;
  data: ExtractedData;
  raw: Invoice;
}

/** Account codes for one invoice, resolved from the client's account_mappings. */
export interface InvoiceMapping {
  /** Supplier account code (falls back to the "ספקים שונים" 3499 code, like the Move-in file). */
  supplierAccount: string;
  supplierAccountIsFallback: boolean;
  /** Expense account code, or null when the invoice has no category. */
  expenseAccount: string | null;
  /** The client's input-VAT account (clients.vat_account). */
  vatAccount: string;
  /** Human-readable problems that block the export (e.g. "קטגוריה: X" without a mapping). */
  missing: string[];
  accountMappings: AccountMapping[];
}

/** The invoice's original file (PDF / image), for plugins that attach it (capabilities.attachPdf). */
export interface InvoiceFile {
  fileName: string;
  contentType: 'application/pdf' | 'image/jpeg' | 'image/png';
  bytes: Uint8Array;
}

/** Loads an invoice's own file from Storage (server-side; only the client's own raw-invoices objects). */
export interface InvoiceFileLoader {
  load(invoice: ExportInvoice): Promise<InvoiceFile>;
}

export interface ExportResult {
  externalId: string;
  url?: string;
}

export interface ExistingDocument {
  externalId: string;
  url?: string;
}

export interface TestConnectionResult {
  ok: boolean;
  /** Hebrew message for the UI. Never include secrets. */
  message: string;
}

export interface ExternalEntity {
  id: string;
  name: string;
  code?: string;
}

export interface FileExportOutput {
  fileName: string;
  contentType: string;
  body: Buffer;
  /** Invoices actually written to the file (others were skipped, e.g. no data). */
  invoiceIds: string[];
}

// ── HTTP + logging ────────────────────────────────────────────────────────

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';

export interface HttpRequestOptions {
  /** Logical name stored in integration_logs.operation, e.g. "export_invoice", "test_connection". */
  operation: string;
  method: HttpMethod;
  url: string;
  headers?: Record<string, string>;
  /** JSON body (serialized + Content-Type set by the client). */
  json?: unknown;
  /** Raw body (string / bytes). Mutually exclusive with json. */
  body?: string | Uint8Array;
  timeoutMs?: number;
  /**
   * Whether repeating the request is safe. Defaults to true for GET/HEAD/PUT/DELETE and false for
   * POST/PATCH. Set true on a POST only when it carries an idempotency key the target honours.
   */
  idempotent?: boolean;
  /** Overrides the context's invoice id for this call's log row. */
  invoiceId?: string | null;
}

export interface HttpResponse<T = unknown> {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  /** Parsed JSON when the response is JSON, else the text. */
  body: T;
  text: string;
  durationMs: number;
  attempts: number;
}

export interface IntegrationHttpClient {
  request<T = unknown>(options: HttpRequestOptions): Promise<HttpResponse<T>>;
  /** Same client, logging calls under another invoice id. */
  forInvoice(invoiceId: string | null): IntegrationHttpClient;
}

/** One integration_logs row (already redacted / truncated). */
export interface IntegrationLogRow {
  org_id: string | null;
  client_id: string;
  plugin_id: string;
  invoice_id: string | null;
  correlation_id: string;
  operation: string;
  http_method: string | null;
  url: string | null;
  request_body: string | null;
  response_status: number | null;
  response_body: string | null;
  duration_ms: number | null;
  attempt: number;
  outcome: 'ok' | 'error' | 'retry';
  error_code: string | null;
  error_message: string | null;
}

export interface IntegrationLogSink {
  write(row: IntegrationLogRow): Promise<void>;
}

export interface IntegrationLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  /** Records a non-HTTP operation (e.g. a file export) in integration_logs. */
  record(entry: {
    operation: string;
    outcome: 'ok' | 'error';
    invoiceId?: string | null;
    durationMs?: number;
    errorCode?: string | null;
    errorMessage?: string | null;
    details?: unknown;
  }): Promise<void>;
}

export interface PluginContext<C = Record<string, unknown>> {
  pluginId: string;
  clientId: string;
  orgId: string | null;
  environment: IntegrationEnvironment;
  /** Decrypted, schema-validated config. Server-side only; never return or log it. */
  config: C;
  http: IntegrationHttpClient;
  logger: IntegrationLogger;
  correlationId: string;
  dryRun: boolean;
  /** Invoice file access for plugins that attach the document (absent in some test contexts). */
  files?: InvoiceFileLoader;
}

// ── Plugins ───────────────────────────────────────────────────────────────

interface BasePlugin<C> {
  /** Stable id: lowercase, digits, "-" (stored in client_integrations / invoice_exports / logs). */
  id: string;
  /** Hebrew name for the UI. */
  displayName: string;
  /** Hebrew one-liner for the UI. */
  description: string;
  kind: PluginKind;
  configSchema: z.ZodType<C>;
  configFields: ConfigField[];
  capabilities: PluginCapabilities;
  testConnection(ctx: PluginContext<C>): Promise<TestConnectionResult>;
  /** Extra plugin-specific checks; returned strings block the export of that invoice. */
  validateInvoice?(invoice: ExportInvoice, mapping: InvoiceMapping): string[];
}

export interface ApiExportPlugin<C = Record<string, unknown>, P = unknown> extends BasePlugin<C> {
  kind: 'api';
  /** Builds the request payload (used for dry runs and by exportInvoice). Must be pure. */
  buildPayload(ctx: PluginContext<C>, invoice: ExportInvoice, mapping: InvoiceMapping): P;
  exportInvoice(ctx: PluginContext<C>, invoice: ExportInvoice, mapping: InvoiceMapping): Promise<ExportResult>;
  /** Looks the invoice up in the target (idempotency after an uncertain earlier attempt). */
  findExisting?(ctx: PluginContext<C>, invoice: ExportInvoice): Promise<ExistingDocument | null>;
  /** For the mapping UI: the target's suppliers / accounts. */
  listSuppliers?(ctx: PluginContext<C>): Promise<ExternalEntity[]>;
  listAccounts?(ctx: PluginContext<C>): Promise<ExternalEntity[]>;
}

export interface FileExportPlugin<C = Record<string, unknown>> extends BasePlugin<C> {
  kind: 'file';
  /** Builds one file for all the invoices (no network). */
  buildFile(ctx: PluginContext<C>, items: { invoice: ExportInvoice; mapping: InvoiceMapping }[]): FileExportOutput;
}

// Plugins are registered with their own config type; the registry stores them type-erased (plugin
// methods use method syntax, so a plugin of config type C is assignable to the unknown variant).
export type AnyApiPlugin = ApiExportPlugin<unknown, unknown>;
export type AnyFilePlugin = FileExportPlugin<unknown>;
export type ExportPlugin = AnyApiPlugin | AnyFilePlugin;

/** What the browser may know about a plugin (no functions, no schema). */
export interface PluginInfo {
  id: string;
  displayName: string;
  description: string;
  kind: PluginKind;
  capabilities: PluginCapabilities;
  configFields: ConfigField[];
}

// ── Stored rows ───────────────────────────────────────────────────────────

export type InvoiceExportStatus = 'pending' | 'success' | 'failed' | 'skipped';

export interface InvoiceExportRecord {
  id: string;
  invoice_id: string;
  client_id: string;
  plugin_id: string;
  status: InvoiceExportStatus;
  external_id: string | null;
  external_url: string | null;
  attempts: number;
  last_error: string | null;
  /** The last failed attempt may have created the document anyway (timeout / 5xx on a write). */
  outcome_uncertain?: boolean;
  correlation_id: string | null;
  exported_at: string | null;
  created_at: string;
  updated_at: string;
}

/** client_integrations row as the browser sees it (no ciphertext). */
export interface ClientIntegrationView {
  id: string;
  client_id: string;
  plugin_id: string;
  enabled: boolean;
  environment: IntegrationEnvironment;
  config_masked: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface IntegrationLogRecord extends IntegrationLogRow {
  id: string;
  created_at: string;
}
