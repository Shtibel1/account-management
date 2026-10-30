import { NextResponse } from 'next/server';
import { removeClientContact } from '@/lib/clientChannels';
import { requireClientAccess } from '@/lib/auth';

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string; contactId: string }> }
) {
  const { id, contactId } = await params;

  // removeClientContact() deletes only where client_id = id.
  const access = await requireClientAccess(id);
  if (!access.ok) return access.response;

  const result = await removeClientContact(id, contactId);
  if (!result.ok) {
    console.error(`[Contacts API] Failed to remove contact ${contactId} of client ${id}:`, result.error);
    return NextResponse.json({ error: result.error }, { status: 500 });
  }
  return NextResponse.json({ success: true });
}
