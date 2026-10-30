import { NextResponse } from 'next/server';
import { channelSettings, listClientChannels } from '@/lib/clientChannels';
import { accessibleClientIds, requireUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/** Inbound email aliases + WhatsApp contacts for every client, and which channels are configured. */
export async function GET() {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;

  try {
    // Only the clients of the user's organizations (null = mock mode, all clients).
    const clients = await listClientChannels(await accessibleClientIds(auth.value));
    return NextResponse.json({ settings: channelSettings(), clients });
  } catch (err) {
    console.error('[Channels API] Failed to list client channels:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
