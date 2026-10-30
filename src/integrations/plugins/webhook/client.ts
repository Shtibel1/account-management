import { createHmac } from 'node:crypto';
import type { HttpResponse, PluginContext } from '@/integrations/types';
import type { WebhookInvoicePayload } from '@/integrations/plugins/webhook/mapping';

export interface WebhookConfig {
  url: string;
  authToken?: string;
  signingSecret?: string;
}

/** Response the receiver may return: { "id": "...", "url": "..." } (both optional). */
export interface WebhookAck {
  id?: unknown;
  external_id?: unknown;
  url?: unknown;
}

/** HMAC-SHA256 over "<unix ts>.<body>", hex. */
export function webhookSignature(secret: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

function headersFor(ctx: PluginContext<WebhookConfig>, body: string, idempotencyKey?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Invoice-Scan-Environment': ctx.environment,
    'X-Correlation-Id': ctx.correlationId,
  };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  if (ctx.config.authToken) headers.Authorization = `Bearer ${ctx.config.authToken}`;
  if (ctx.config.signingSecret) {
    const ts = Math.floor(Date.now() / 1000).toString();
    headers['X-Signature'] = `t=${ts},v1=${webhookSignature(ctx.config.signingSecret, ts, body)}`;
  }
  return headers;
}

/** All calls go through ctx.http (logging, retries, redaction, URL guard). */
export async function postPing(ctx: PluginContext<WebhookConfig>): Promise<HttpResponse> {
  const body = JSON.stringify({ event: 'ping', version: 1, environment: ctx.environment });
  return ctx.http.request({
    operation: 'test_connection',
    method: 'POST',
    url: ctx.config.url,
    headers: headersFor(ctx, body),
    body,
    idempotent: true, // a ping has no side effects
    invoiceId: null,
  });
}

export async function postInvoice(
  ctx: PluginContext<WebhookConfig>,
  payload: WebhookInvoicePayload
): Promise<HttpResponse<WebhookAck | string>> {
  const body = JSON.stringify(payload);
  return ctx.http.request<WebhookAck | string>({
    operation: 'export_invoice',
    method: 'POST',
    url: ctx.config.url,
    headers: headersFor(ctx, body, payload.idempotency_key),
    body,
    // The Idempotency-Key header lets the receiver drop repeats, so retrying a 5xx is safe.
    idempotent: true,
    invoiceId: payload.invoice.id,
  });
}
