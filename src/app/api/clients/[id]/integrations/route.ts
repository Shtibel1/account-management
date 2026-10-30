import { NextResponse } from 'next/server';
import { requireClientAccess } from '@/lib/auth';
import { isEncryptionConfigured } from '@/lib/secrets';
import { registry } from '@/integrations/registry';
import { listClientIntegrations } from '@/integrations/store';

export const dynamic = 'force-dynamic';

/** The client's integration settings (masked config only) + the available plugins. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await requireClientAccess(id);
  if (!access.ok) return access.response;

  try {
    const integrations = await listClientIntegrations(id);
    return NextResponse.json({
      plugins: registry.info(),
      integrations,
      encryptionConfigured: isEncryptionConfigured(),
    });
  } catch (err) {
    console.error(`[Integrations API] Failed to load integrations for client ${id}:`, err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: 'שגיאה בטעינת הגדרות החיבור' }, { status: 500 });
  }
}
