import { lookup as dnsLookup } from 'node:dns/promises';
import type {
  HttpMethod,
  HttpRequestOptions,
  HttpResponse,
  IntegrationHttpClient,
  IntegrationLogger,
  IntegrationLogRow,
  IntegrationLogSink,
} from '@/integrations/types';
import { bodyForLog, redactDeep, redactUrl, scrubString, type RedactionOptions } from '@/integrations/redact';
import { DEFAULT_RETRY_POLICY, decideRetry, type AttemptFailure, type RetryPolicy } from '@/integrations/retry';

/**
 * The logging HTTP client every plugin MUST use for outbound calls (never call fetch directly):
 *   - per-attempt timeout (AbortController), default 15s;
 *   - retries with exponential backoff + jitter on 429 / 5xx / network errors, honouring Retry-After
 *     (policy in retry.ts; non-idempotent POSTs are only retried when certainly not processed);
 *   - outbound URL guard (https only, no localhost / private / link-local addresses);
 *   - one integration_logs row per attempt (redacted, bodies truncated to 20KB) + one structured
 *     JSON console line per attempt (no bodies), all tagged with the export run's correlation id.
 * Logging failures never fail the request.
 */

export const DEFAULT_TIMEOUT_MS = 15_000;
/** Responses bigger than this are cut off (the plugin gets the truncated text). */
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

export class IntegrationHttpError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly attempts: number,
    public readonly status: number | null = null
  ) {
    super(message);
    this.name = 'IntegrationHttpError';
  }
}

// ── Outbound URL guard (SSRF) ──────────────────────────────────────────────

function ipv4Parts(host: string): number[] | null {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((p) => p >= 0 && p <= 255) ? parts : null;
}

function isPrivateIpv4([a, b]: number[]): boolean {
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/** IPv4 / IPv6 literal (brackets stripped) that is loopback / private / link-local / reserved. */
export function isPrivateIpLiteral(rawHost: string): boolean {
  const host = rawHost.toLowerCase().replace(/^\[|\]$/g, '');
  const v4 = ipv4Parts(host);
  if (v4) return isPrivateIpv4(v4);
  if (!host.includes(':')) return false;
  const mapped = host.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) {
    const parts = ipv4Parts(mapped[1]);
    return parts ? isPrivateIpv4(parts) : true;
  }
  // loopback, unspecified, unique-local, link-local, site-local, multicast, IPv4-mapped / -compatible,
  // NAT64 (64:ff9b::/96) and 6to4 (2002::/16, may embed a private IPv4).
  return (
    host === '::1' || host === '::' || /^f[cd]/.test(host) || /^fe[89a-f]/.test(host) || /^ff/.test(host) ||
    host.startsWith('::ffff:') || /^::[0-9a-f]/.test(host) || host.startsWith('64:ff9b:') || host.startsWith('2002:')
  );
}

/** Resolves a host name to its addresses (injectable for tests). */
export type HostResolver = (host: string) => Promise<string[]>;

export const defaultHostResolver: HostResolver = async (host) =>
  (await dnsLookup(host, { all: true, verbatim: true })).map((a) => a.address);

/**
 * DNS half of the SSRF guard: every address the host name resolves to must be public. (A host that
 * resolves differently between this check and the connection - DNS rebinding with a tiny TTL - is
 * not fully excluded, but static internal names pointing at private addresses are.)
 */
export async function assertResolvedHostPublic(url: URL, resolve: HostResolver): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (ipv4Parts(host) || host.includes(':')) return; // literal, already checked
  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch {
    throw new IntegrationHttpError('לא ניתן לאתר את שם השרת', 'dns_failed', 0);
  }
  if (addresses.length === 0) throw new IntegrationHttpError('לא ניתן לאתר את שם השרת', 'dns_failed', 0);
  if (addresses.some((a) => isPrivateIpLiteral(a))) {
    throw new IntegrationHttpError('כתובת פנימית אינה מותרת', 'private_address', 0);
  }
}

/**
 * Throws unless `rawUrl` is an https URL to a public host name / address (literal checks; the HTTP
 * client additionally resolves the host name, see assertResolvedHostPublic).
 */
export function assertOutboundUrlAllowed(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new IntegrationHttpError('כתובת לא תקינה', 'invalid_url', 0);
  }
  if (url.protocol !== 'https:') throw new IntegrationHttpError('נדרשת כתובת https', 'insecure_url', 0);
  if (url.username || url.password) throw new IntegrationHttpError('אין לכלול פרטי התחברות בכתובת', 'credentials_in_url', 0);
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') ||
    host === 'metadata.google.internal' || !host.includes('.') && !host.includes(':')
  ) {
    throw new IntegrationHttpError('כתובת פנימית אינה מותרת', 'private_address', 0);
  }
  if (isPrivateIpLiteral(host)) throw new IntegrationHttpError('כתובת פנימית אינה מותרת', 'private_address', 0);
  return url;
}

// ── Client ────────────────────────────────────────────────────────────────

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface HttpClientOptions {
  pluginId: string;
  clientId: string;
  orgId: string | null;
  correlationId: string;
  invoiceId?: string | null;
  redaction: RedactionOptions;
  sink: IntegrationLogSink;
  policy?: RetryPolicy;
  defaultTimeoutMs?: number;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
  /** Disable the URL guard (scratch tests only). */
  allowAnyUrl?: boolean;
  /**
   * Host name resolver for the DNS part of the URL guard. Defaults to the system resolver when the
   * real fetch is used; with an injected fetchImpl (tests) the DNS check is skipped unless given.
   */
  resolveHost?: HostResolver | null;
  /** Console line writer (default console.log). */
  consoleLine?: (line: string) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function defaultIdempotent(method: HttpMethod): boolean {
  return method !== 'POST' && method !== 'PATCH';
}

function errorCodeOf(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null;
  const e = err as { code?: unknown; cause?: { code?: unknown } };
  if (typeof e.cause?.code === 'string') return e.cause.code;
  if (typeof e.code === 'string') return e.code;
  return null;
}

function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => { out[key.toLowerCase()] = value; });
  return out;
}

async function readLimited(res: Response): Promise<string> {
  const buf = new Uint8Array(await res.arrayBuffer());
  const limited = buf.length > MAX_RESPONSE_BYTES ? buf.subarray(0, MAX_RESPONSE_BYTES) : buf;
  return new TextDecoder('utf-8').decode(limited);
}

export function createIntegrationHttpClient(options: HttpClientOptions): IntegrationHttpClient {
  const policy = options.policy ?? DEFAULT_RETRY_POLICY;
  const fetchImpl: FetchLike = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  const consoleLine = options.consoleLine ?? ((line: string) => console.log(line));
  const redaction = options.redaction;
  const resolveHost = options.resolveHost !== undefined
    ? options.resolveHost
    : (options.fetchImpl ? null : defaultHostResolver);

  const writeLog = async (row: IntegrationLogRow) => {
    consoleLine(JSON.stringify({
      ts: new Date(now()).toISOString(),
      level: row.outcome === 'error' ? 'error' : row.outcome === 'retry' ? 'warn' : 'info',
      event: 'integration_http',
      correlationId: row.correlation_id,
      pluginId: row.plugin_id,
      clientId: row.client_id,
      invoiceId: row.invoice_id,
      operation: row.operation,
      method: row.http_method,
      url: row.url,
      status: row.response_status,
      durationMs: row.duration_ms,
      attempt: row.attempt,
      outcome: row.outcome,
      errorCode: row.error_code,
      errorMessage: row.error_message,
    }));
    try {
      await options.sink.write(row);
    } catch (err) {
      console.error('[integrations] Failed to store integration log row:', err instanceof Error ? err.message : String(err));
    }
  };

  const request = async <T>(req: HttpRequestOptions, invoiceId: string | null): Promise<HttpResponse<T>> => {
    const method = req.method;
    const idempotent = req.idempotent ?? defaultIdempotent(method);
    const timeoutMs = req.timeoutMs ?? options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    const logInvoiceId = req.invoiceId !== undefined ? req.invoiceId : invoiceId;
    const safeUrl = redactUrl(req.url, redaction);

    const headers: Record<string, string> = { Accept: 'application/json', ...(req.headers ?? {}) };
    let body: string | Uint8Array | undefined = req.body;
    if (req.json !== undefined) {
      body = JSON.stringify(req.json);
      if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
    }
    const requestBodyForLog = bodyForLog(req.json !== undefined ? req.json : body, redaction);

    const baseRow = {
      org_id: options.orgId,
      client_id: options.clientId,
      plugin_id: options.pluginId,
      invoice_id: logInvoiceId ?? null,
      correlation_id: options.correlationId,
      operation: req.operation,
      http_method: method,
      url: safeUrl,
      request_body: requestBodyForLog,
    };

    if (!options.allowAnyUrl) {
      try {
        const parsedUrl = assertOutboundUrlAllowed(req.url);
        if (resolveHost) await assertResolvedHostPublic(parsedUrl, resolveHost);
      } catch (err) {
        const e = err as IntegrationHttpError;
        await writeLog({
          ...baseRow, response_status: null, response_body: null, duration_ms: 0, attempt: 1,
          outcome: 'error', error_code: e.code, error_message: e.message,
        });
        throw err;
      }
    }

    for (let attempt = 1; ; attempt++) {
      const started = now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let failure: AttemptFailure | null = null;
      let response: HttpResponse<T> | null = null;
      let errMessage: string | null = null;
      let errCode: string | null = null;

      try {
        const res = await fetchImpl(req.url, {
          method,
          headers,
          body: method === 'GET' || method === 'HEAD' ? undefined : (body as BodyInit | undefined),
          signal: controller.signal,
          redirect: 'manual',
        });
        const text = await readLimited(res);
        const resHeaders = headersToObject(res.headers);
        let parsed: unknown = text;
        if ((resHeaders['content-type'] ?? '').includes('json') && text.trim()) {
          try { parsed = JSON.parse(text); } catch { parsed = text; }
        }
        response = {
          status: res.status, ok: res.ok, headers: resHeaders, body: parsed as T, text,
          durationMs: now() - started, attempts: attempt,
        };
        if (!res.ok) failure = { kind: 'status', status: res.status, retryAfter: resHeaders['retry-after'] ?? null };
      } catch (err) {
        if (controller.signal.aborted) {
          failure = { kind: 'timeout' };
          errCode = 'timeout';
          errMessage = `Request timed out after ${timeoutMs}ms`;
        } else {
          errCode = errorCodeOf(err) ?? 'network_error';
          failure = { kind: 'network', code: errCode };
          errMessage = scrubString(err instanceof Error ? err.message : String(err), redaction.secretValues);
        }
      } finally {
        clearTimeout(timer);
      }

      const durationMs = now() - started;
      const decision = failure
        ? decideRetry({ attempt, failure, idempotent, policy, now: now(), random: random() })
        : null;
      // A 2xx answer whose body is a vendor error envelope is an error too (QA N10).
      let envelopeError: { code: string; message: string } | null = null;
      if (!failure && response && req.bodyError) {
        try {
          envelopeError = req.bodyError({ status: response.status, body: response.body, text: response.text });
        } catch {
          envelopeError = null;
        }
      }
      const outcome: IntegrationLogRow['outcome'] = envelopeError ? 'error' : !failure ? 'ok' : decision?.retry ? 'retry' : 'error';

      await writeLog({
        ...baseRow,
        response_status: response?.status ?? null,
        response_body: response ? bodyForLog(response.text, redaction) : null,
        duration_ms: durationMs,
        attempt,
        outcome,
        error_code: envelopeError
          ? envelopeError.code.slice(0, 100)
          : response && !response.ok ? `http_${response.status}` : errCode,
        error_message: envelopeError
          ? scrubString(envelopeError.message, redaction.secretValues).slice(0, 2000)
          : response && !response.ok
            ? `HTTP ${response.status}${decision && !decision.retry ? ` (${decision.reason})` : ''}`
            : errMessage,
      });

      if (!failure && response) return response;
      if (decision?.retry) {
        await sleep(decision.delayMs);
        continue;
      }
      // Final failure: an HTTP error response goes back to the plugin; a network error / timeout throws.
      if (response) return response;
      throw new IntegrationHttpError(
        errMessage ?? 'Request failed',
        errCode ?? 'network_error',
        attempt
      );
    }
  };

  const make = (invoiceId: string | null): IntegrationHttpClient => ({
    request: <T>(req: HttpRequestOptions) => request<T>(req, invoiceId),
    forInvoice: (id: string | null) => make(id),
  });

  return make(options.invoiceId ?? null);
}

// ── Logger ────────────────────────────────────────────────────────────────

export interface LoggerOptions {
  pluginId: string;
  clientId: string;
  orgId: string | null;
  correlationId: string;
  redaction: RedactionOptions;
  sink: IntegrationLogSink;
  consoleLine?: (line: string) => void;
}

/** Structured, redacting logger for plugin code (console JSON lines + record() into integration_logs). */
export function createIntegrationLogger(options: LoggerOptions): IntegrationLogger {
  const consoleLine = options.consoleLine ?? ((line: string) => console.log(line));
  const line = (level: 'info' | 'warn' | 'error', message: string, meta?: Record<string, unknown>) => {
    consoleLine(JSON.stringify({
      ts: new Date().toISOString(),
      level,
      event: 'integration_log',
      correlationId: options.correlationId,
      pluginId: options.pluginId,
      clientId: options.clientId,
      message: scrubString(message, options.redaction.secretValues),
      ...(meta ? { meta: redactDeep(meta, options.redaction) } : {}),
    }));
  };

  return {
    info: (m, meta) => line('info', m, meta),
    warn: (m, meta) => line('warn', m, meta),
    error: (m, meta) => line('error', m, meta),
    record: async (entry) => {
      const row: IntegrationLogRow = {
        org_id: options.orgId,
        client_id: options.clientId,
        plugin_id: options.pluginId,
        invoice_id: entry.invoiceId ?? null,
        correlation_id: options.correlationId,
        operation: entry.operation,
        http_method: null,
        url: null,
        request_body: entry.details === undefined ? null : bodyForLog(entry.details, options.redaction),
        response_status: null,
        response_body: null,
        duration_ms: entry.durationMs ?? null,
        attempt: 1,
        outcome: entry.outcome,
        error_code: entry.errorCode ?? null,
        error_message: entry.errorMessage ? scrubString(entry.errorMessage, options.redaction.secretValues) : null,
      };
      line(entry.outcome === 'error' ? 'error' : 'info', `operation ${entry.operation}: ${entry.outcome}`, {
        invoiceId: row.invoice_id, errorCode: row.error_code, errorMessage: row.error_message,
      });
      try {
        await options.sink.write(row);
      } catch (err) {
        console.error('[integrations] Failed to store integration log row:', err instanceof Error ? err.message : String(err));
      }
    },
  };
}
