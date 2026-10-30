import { NextResponse } from 'next/server';
import { addClientContact } from '@/lib/clientChannels';

/** Adds a WhatsApp contact phone for the client. Body: { phone, name? } */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const body = (await request.json()) as { phone?: unknown; name?: unknown };
    if (typeof body.phone !== 'string' || !body.phone.trim()) {
      return NextResponse.json({ error: 'יש להזין מספר טלפון' }, { status: 400 });
    }
    const name = typeof body.name === 'string' ? body.name : null;

    const result = await addClientContact(id, body.phone, name);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json(result.contact, { status: 201 });
  } catch (err) {
    console.error(`[Contacts API] Failed to add contact for client ${id}:`, err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
