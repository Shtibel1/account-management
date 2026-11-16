import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { supabase } from '@/lib/supabase';
import { accessibleClientIds, isUuid, requireClientsAccess, requireUser } from '@/lib/auth';
import type { AccountMapping, Invoice } from '@/shared/types';
import { getPlugin } from '@/integrations/registry';
import { secretsOf } from '@/integrations/config';
import { runExport } from '@/integrations/exportRunner';
import { supabaseExportStore } from '@/integrations/store';
import { buildPluginContext, IntegrationConfigError, resolveIntegration } from '@/integrations/service';
import { SecretsError } from '@/lib/secrets';

export const dynamic = 'force-dynamic';

const MAX_INVOICES = 200;

const bodySchema = z.object({
  invoiceIds: z.array(z.string().min(1).max(100)).min(1).max(MAX_INVOICES),
  pluginId: z.string().min(1).max(64),
  dryRun: z.boolean().optional(),
  force: z.boolean().optional(),
});

/**
 * Exports approved invoices of ONE client through an export plugin.
 * Body: { invoiceIds, pluginId, dryRun?, force? }
 *   - idempotent per (invoice, plugin): already exported invoices are skipped (invoice_exports);
 *   - dryRun: builds the payloads / file without sending or recording anything;
 *   - force: also re-sends invoices whose earlier attempt is uncertain (see idempotency.ts).
 * Every outbound call is logged in integration_logs under the run's correlationId.
 * The legacy POST /api/export (Move-in download) is unchanged.
 */
export async function POST(request: Request) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;

  let body: z.infer<typeof bodySchema>;
  try {
    const parsed = bodySchema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: 'בקשה לא תקינה' }, { status: 400 });
    body = parsed.data;
  } catch {
    return NextResponse.json({ error: 'בקשה לא תקינה' }, { status: 400 });
  }

  const plugin = getPlugin(body.pluginId);
  if (!plugin) return NextResponse.json({ error: 'תוסף לא מוכר' }, { status: 404 });

  const ids = [...new Set(body.invoiceIds)];
  if (!auth.value.mock && ids.some((id) => !isUuid(id))) {
    return NextResponse.json({ error: 'חלק מהחשבוניות לא נמצאו' }, { status: 404 });
  }
  const { data: invoiceRows, error: fetchErr } = await supabase.from('invoices').select('*').in('id', ids);
  if (fetchErr) {
    console.error('[Integrations export] Failed to load invoices:', fetchErr.message);
    return NextResponse.json({ error: 'שגיאה בטעינת החשבוניות' }, { status: 500 });
  }
  // Invoices of other offices count as "not found" (same 404 as an unknown id), so the answer
  // never reveals that an id exists in another office.
  let allowedClients: string[] | null;
  try {
    allowedClients = await accessibleClientIds(auth.value);
  } catch (err) {
    console.error('[Integrations export] Access check failed:', err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: 'שגיאה בבדיקת הרשאות' }, { status: 500 });
  }
  const invoices = ((invoiceRows ?? []) as Invoice[]).filter(
    (inv) => allowedClients === null || allowedClients.includes(inv.client_id)
  );
  if (invoices.length !== ids.length) {
    return NextResponse.json({ error: 'חלק מהחשבוניות לא נמצאו' }, { status: 404 });
  }

  // Every invoice must belong to a client of the user's offices (re-checked), and all to the same client.
  const clientIds = [...new Set(invoices.map((inv) => inv.client_id))];
  const access = await requireClientsAccess(clientIds, auth.value);
  if (!access.ok) return access.response;
  if (clientIds.length > 1) {
    return NextResponse.json({ error: 'יש לייצא חשבוניות של לקוח אחד בכל פעם' }, { status: 400 });
  }
  const clientId = clientIds[0];

  try {
    const [clientRes, mappingsRes] = await Promise.all([
      supabase.from('clients').select('id, vat_account, org_id').eq('id', clientId).single(),
      supabase.from('account_mappings').select('*').eq('client_id', clientId),
    ]);
    if (clientRes.error || !clientRes.data) {
      return NextResponse.json({ error: 'לקוח לא נמצא' }, { status: 404 });
    }
    if (mappingsRes.error) throw new Error(`Failed to load account mappings: ${mappingsRes.error.message}`);
    const client = clientRes.data as { id: string; vat_account: string | null; org_id?: string | null };

    const resolved = await resolveIntegration(plugin, clientId);
    const correlationId = randomUUID();
    const secrets = secretsOf(plugin.configFields, resolved.rawConfig);
    const redaction = { secretKeys: secrets.keys, secretValues: secrets.values };
    const ctx = buildPluginContext({
      plugin,
      clientId,
      orgId: client.org_id ?? null,
      environment: resolved.environment,
      config: resolved.config,
      rawConfig: resolved.rawConfig,
      correlationId,
      dryRun: body.dryRun === true,
    });

    ctx.logger.info('export run started', {
      invoices: ids.length, dryRun: ctx.dryRun, force: body.force === true, environment: ctx.environment,
    });
    const result = await runExport({
      plugin,
      ctx,
      invoices: ids.map((id) => invoices.find((inv) => inv.id === id)!),
      accountMappings: (mappingsRes.data ?? []) as AccountMapping[],
      vatAccount: client.vat_account ?? '',
      store: supabaseExportStore(),
      dryRun: body.dryRun === true,
      force: body.force === true,
      redaction,
    });
    ctx.logger.info('export run finished', { summary: result.summary });
    return NextResponse.json({ ...result, environment: ctx.environment });
  } catch (err) {
    if (err instanceof IntegrationConfigError) {
      return NextResponse.json({ error: err.message, issues: err.issues }, { status: 422 });
    }
    if (err instanceof SecretsError) {
      console.error('[Integrations export] Config decryption failed:', err.message);
      return NextResponse.json({ error: 'לא ניתן לפענח את הגדרות החיבור. שמרו אותן מחדש.' }, { status: 422 });
    }
    console.error(`[Integrations export] Export to ${plugin.id} for client ${clientId} crashed:`, err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: 'הייצוא נכשל' }, { status: 500 });
  }
}
