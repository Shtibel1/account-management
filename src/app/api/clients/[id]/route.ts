import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { requireClientAccess, requireOrgOwner } from '@/lib/auth';
import { RAW_BUCKET } from '@/lib/invoiceFiles';
import { CLIENT_DELETE_MESSAGES, deleteClientWithFiles, type ClientDeletionDb } from '@/lib/clientDeletion';

export const dynamic = 'force-dynamic';

/**
 * DELETE /api/clients/[id]: deletes a client and its stored files (QA round 4 #1). Office owners
 * only (403 otherwise). A client is deleted only while all its invoices failed processing or await
 * review, none was ever exported and none has status audit history (409 with the reason otherwise:
 * approved / exported books are never wiped). The rule lives in the DB (delete_client_guarded,
 * migration 20261031101000_qa4_client_delete_guard.sql), which also guards direct REST deletes.
 * Answers `{ success: true, filesRemoved, filesFailed }`.
 */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await requireClientAccess(id);
  if (!access.ok) return access.response;
  if (access.value.ctx.mock) {
    return NextResponse.json({ error: 'מחיקת לקוח אינה זמינה במצב הדגמה' }, { status: 400 });
  }
  const owner = await requireOrgOwner(access.value.orgId, access.value.ctx);
  if (!owner.ok) return owner.response;

  try {
    const result = await deleteClientWithFiles(supabase as unknown as ClientDeletionDb, RAW_BUCKET, id);
    if (result.ok) {
      return NextResponse.json({ success: true, filesRemoved: result.filesRemoved, filesFailed: result.filesFailed });
    }
    if ('blocker' in result) {
      const status = result.blocker === 'not_found' ? 404 : result.blocker === 'not_owner' ? 403 : 409;
      return NextResponse.json({ error: CLIENT_DELETE_MESSAGES[result.blocker], reason: result.blocker }, { status });
    }
    console.error(`[clients/${id}] DELETE failed:`, result.error);
    return NextResponse.json({ error: 'שגיאה במחיקת הלקוח' }, { status: 500 });
  } catch (err) {
    console.error(`[clients/${id}] DELETE failed:`, err);
    return NextResponse.json({ error: 'שגיאה במחיקת הלקוח' }, { status: 500 });
  }
}
