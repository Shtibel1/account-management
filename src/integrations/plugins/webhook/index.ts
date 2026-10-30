import { z } from 'zod';
import type { ApiExportPlugin } from '@/integrations/types';
import { assertOutboundUrlAllowed } from '@/integrations/http';
import { toWebhookPayload, type WebhookInvoicePayload } from '@/integrations/plugins/webhook/mapping';
import { postInvoice, postPing, type WebhookAck, type WebhookConfig } from '@/integrations/plugins/webhook/client';

const httpsPublicUrl = z.string().trim().url('כתובת לא תקינה').refine((value) => {
  try {
    assertOutboundUrlAllowed(value);
    return true;
  } catch {
    return false;
  }
}, 'נדרשת כתובת https ציבורית');

const configSchema: z.ZodType<WebhookConfig> = z.object({
  url: httpsPublicUrl,
  authToken: z.string().min(8, 'טוקן קצר מדי').max(4096).optional(),
  signingSecret: z.string().min(16, 'סוד חתימה קצר מדי (לפחות 16 תווים)').max(4096).optional(),
}).strict();

function externalIdFrom(body: WebhookAck | string, fallback: string): { externalId: string; url?: string } {
  if (body && typeof body === 'object') {
    const id = body.id ?? body.external_id;
    const url = typeof body.url === 'string' && /^https:\/\//.test(body.url) ? body.url.slice(0, 2000) : undefined;
    if (typeof id === 'string' || typeof id === 'number') return { externalId: String(id).slice(0, 200), url };
    return { externalId: fallback, url };
  }
  return { externalId: fallback };
}

/**
 * Generic JSON webhook: POSTs each approved invoice to an https endpoint of the office (its own
 * middleware, Make / Zapier, a bookkeeping system's import hook). Reference 'api' plugin.
 */
export const webhookPlugin: ApiExportPlugin<WebhookConfig, WebhookInvoicePayload> = {
  id: 'webhook',
  displayName: 'Webhook (JSON)',
  description: 'שליחת כל חשבונית מאושרת כ-JSON לכתובת https של המשרד (מערכת ביניים, Make / Zapier וכדומה).',
  kind: 'api',
  configSchema,
  configFields: [
    { key: 'url', label: 'כתובת ה-Webhook', type: 'url', secret: false, required: true, placeholder: 'https://example.com/hooks/invoices' },
    { key: 'authToken', label: 'טוקן גישה (Bearer)', type: 'password', secret: true, required: false, help: 'נשלח בכותרת Authorization.' },
    { key: 'signingSecret', label: 'סוד לחתימת HMAC', type: 'password', secret: true, required: false, help: 'כותרת X-Signature: t=<זמן>,v1=HMAC-SHA256 של t.body' },
  ],
  capabilities: { attachPdf: false, allocationNumber: true, duplicateCheck: false, sandbox: true },

  async testConnection(ctx) {
    const res = await postPing(ctx);
    if (res.ok) return { ok: true, message: `החיבור תקין (HTTP ${res.status}).` };
    if (res.status === 401 || res.status === 403) return { ok: false, message: `הגישה נדחתה (HTTP ${res.status}). בדקו את הטוקן.` };
    return { ok: false, message: `השרת החזיר HTTP ${res.status}.` };
  },

  buildPayload(ctx, invoice, mapping) {
    return toWebhookPayload(invoice, mapping, ctx.environment);
  },

  async exportInvoice(ctx, invoice, mapping) {
    const payload = toWebhookPayload(invoice, mapping, ctx.environment);
    const res = await postInvoice(ctx, payload);
    if (!res.ok) throw new Error(`ה-Webhook החזיר HTTP ${res.status}`);
    return externalIdFrom(res.body, `webhook:${payload.idempotency_key}`);
  },
};
