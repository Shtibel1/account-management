import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { requireClientAccess } from '@/lib/auth';
import { getPlugin } from '@/integrations/registry';
import { mergeConfigUpdate, secretsOf, type ConfigValues } from '@/integrations/config';
import { scrubString } from '@/integrations/redact';
import { getStoredIntegration } from '@/integrations/store';
import { buildPluginContext, decryptStoredConfig, IntegrationConfigError, validateConfig } from '@/integrations/service';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  environment: z.enum(['sandbox', 'production']).optional(),
  /** Unsaved form values; merged over the stored config (masked secrets keep the stored value). */
  config: z.record(z.unknown()).optional(),
});

/** "בדוק חיבור": runs the plugin's testConnection (logged in integration_logs like every call). */
export async function POST(request: Request, { params }: { params: Promise<{ id: string; pluginId: string }> }) {
  const { id, pluginId } = await params;
  const access = await requireClientAccess(id);
  if (!access.ok) return access.response;

  const plugin = getPlugin(pluginId);
  if (!plugin) return NextResponse.json({ error: 'תוסף לא מוכר' }, { status: 404 });

  let body: z.infer<typeof bodySchema> = {};
  try {
    const text = await request.text();
    if (text.trim()) {
      const parsed = bodySchema.safeParse(JSON.parse(text));
      if (!parsed.success) return NextResponse.json({ error: 'בקשה לא תקינה' }, { status: 400 });
      body = parsed.data;
    }
  } catch {
    return NextResponse.json({ error: 'בקשה לא תקינה' }, { status: 400 });
  }

  let rawConfig: ConfigValues = {};
  try {
    const stored = await getStoredIntegration(id, plugin.id);
    let existing: ConfigValues = {};
    if (stored?.config_encrypted) {
      try {
        existing = decryptStoredConfig(stored);
      } catch (err) {
        console.error(`[Integrations API] Stored config of client ${id} / ${plugin.id} cannot be decrypted:`, err instanceof Error ? err.message : String(err));
      }
    }
    rawConfig = mergeConfigUpdate(plugin.configFields, existing, body.config ?? {});
    const config = validateConfig(plugin, rawConfig);
    const environment = body.environment ?? stored?.environment ?? 'sandbox';

    const ctx = buildPluginContext({
      plugin,
      clientId: id,
      orgId: access.value.orgId,
      environment: plugin.capabilities.sandbox ? environment : 'production',
      config,
      rawConfig,
      correlationId: randomUUID(),
      dryRun: false,
    });
    const result = await plugin.testConnection(ctx);
    return NextResponse.json({ ...result, correlationId: ctx.correlationId });
  } catch (err) {
    if (err instanceof IntegrationConfigError) {
      return NextResponse.json({ ok: false, message: err.message, issues: err.issues }, { status: 422 });
    }
    const secrets = secretsOf(plugin.configFields, rawConfig);
    const message = scrubString(err instanceof Error ? err.message : String(err), secrets.values);
    console.error(`[Integrations API] testConnection ${plugin.id} for client ${id} failed:`, message);
    return NextResponse.json({ ok: false, message: `בדיקת החיבור נכשלה: ${message}` });
  }
}
