import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { registry } from '@/integrations/registry';

export const dynamic = 'force-dynamic';

/** Available export plugins (public metadata only: no schema, no functions). */
export async function GET() {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  return NextResponse.json({ plugins: registry.info() });
}
