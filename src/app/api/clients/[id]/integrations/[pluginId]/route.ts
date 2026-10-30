import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireClientAccess } from '@/lib/auth';
import { isEncryptionConfigured, SecretsError } from '@/lib/secrets';
import { getPlugin } from '@/integrations/registry';
import { maskConfig, keptSecretsWithChangedEndpoint, mergeConfigUpdate, type ConfigValues } from '@/integrations/config';
import { deleteIntegration, getStoredIntegration, upsertIntegration } from '@/integrations/store';
import {
  decryptStoredConfig,
  encryptConfig,
  IntegrationConfigError,
  validateConfig,
} from '@/integrations/service';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  enabled: z.boolean().optional(),
  environment: z.enum(['sandbox', 'production']).optional(),
  config: z.record(z.unknown()).optional(),
});

type Params = { params: Promise<{ id: string; pluginId: string }> };

/**
 * Saves the client's settings for a plugin. Secrets are encrypted (AES-256-GCM) before storage; a
 * secret sent empty or as its mask keeps the stored value, null clears it. Responds with the masked
 * view only.
 */
export async function PUT(request: Request, { params }: Params) {
  const { id, pluginId } = await params;
  const access = await requireClientAccess(id);
  if (!access.ok) return access.response;

  const plugin = getPlugin(pluginId);
  if (!plugin) return NextResponse.json({ error: 'תוסף לא מוכר' }, { status: 404 });

  let body: z.infer<typeof bodySchema>;
  try {
    const parsed = bodySchema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: 'בקשה לא תקינה' }, { status: 400 });
    body = parsed.data;
  } catch {
    return NextResponse.json({ error: 'בקשה לא תקינה' }, { status: 400 });
  }

  try {
    const stored = await getStoredIntegration(id, plugin.id);
    let existing: ConfigValues = {};
    if (stored?.config_encrypted) {
      try {
        existing = decryptStoredConfig(stored);
      } catch (err) {
        // Key rotated / data damaged: the user has to enter the secrets again.
        console.error(`[Integrations API] Stored config of client ${id} / ${plugin.id} cannot be decrypted:`, err instanceof Error ? err.message : String(err));
      }
    }

    const environment = body.environment ?? stored?.environment ?? (plugin.capabilities.sandbox ? 'sandbox' : 'production');
    if (environment === 'sandbox' && !plugin.capabilities.sandbox) {
      return NextResponse.json({ error: 'לתוסף זה אין סביבת בדיקות' }, { status: 400 });
    }

    const kept = keptSecretsWithChangedEndpoint(plugin.configFields, existing, body.config ?? {});
    if (kept.length > 0) {
      throw new IntegrationConfigError('כתובת השרת השתנתה: יש להזין מחדש את הסודות (או לנקות אותם)', kept);
    }
    const merged = mergeConfigUpdate(plugin.configFields, existing, body.config ?? {});
    validateConfig(plugin, merged);
    if (Object.keys(merged).length > 0 && !isEncryptionConfigured()) {
      return NextResponse.json({ error: 'הצפנת הגדרות אינה מוגדרת בשרת (INTEGRATIONS_ENCRYPTION_KEY)' }, { status: 503 });
    }

    const view = await upsertIntegration(id, plugin.id, {
      enabled: body.enabled ?? stored?.enabled ?? true,
      environment,
      config_encrypted: encryptConfig(id, plugin.id, merged),
      config_masked: maskConfig(plugin.configFields, merged),
    });
    return NextResponse.json(view);
  } catch (err) {
    if (err instanceof IntegrationConfigError) {
      return NextResponse.json({ error: err.message, issues: err.issues }, { status: 422 });
    }
    if (err instanceof SecretsError) {
      console.error('[Integrations API] Encryption failed:', err.message);
      return NextResponse.json({ error: 'שגיאה בהצפנת ההגדרות' }, { status: 503 });
    }
    console.error(`[Integrations API] Failed to save integration ${plugin.id} for client ${id}:`, err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: 'שמירת ההגדרות נכשלה' }, { status: 500 });
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  const { id, pluginId } = await params;
  const access = await requireClientAccess(id);
  if (!access.ok) return access.response;
  const plugin = getPlugin(pluginId);
  if (!plugin) return NextResponse.json({ error: 'תוסף לא מוכר' }, { status: 404 });

  try {
    await deleteIntegration(id, plugin.id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error(`[Integrations API] Failed to delete integration ${plugin.id} for client ${id}:`, err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: 'מחיקת החיבור נכשלה' }, { status: 500 });
  }
}
