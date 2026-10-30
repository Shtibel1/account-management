import { NextResponse } from 'next/server';
import { channelSettings, listClientChannels } from '@/lib/clientChannels';

export const dynamic = 'force-dynamic';

/** Inbound email aliases + WhatsApp contacts for every client, and which channels are configured. */
export async function GET() {
  try {
    const clients = await listClientChannels();
    return NextResponse.json({ settings: channelSettings(), clients });
  } catch (err) {
    console.error('[Channels API] Failed to list client channels:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
