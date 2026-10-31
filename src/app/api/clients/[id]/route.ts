import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { requireClientAccess, requireOrgOwner } from '@/lib/auth';
import { RAW_BUCKET } from '@/lib/invoiceFiles';
import { CLIENT_DELETE_MESSAGES, deleteClientWithFiles, type ClientDeletionDb } from '@/lib/clientDeletion';
import { updateClientRecord } from '@/lib/clientRecords';
import { serviceClientRecordsDb } from '@/lib/clientRecordsDb';

export const dynamic = 'force-dynamic';

/**
 * PATCH /api/clients/[id] { name?, vatAccount? }: renames the client and / or changes its input-VAT
 * account (any member of the client's office). A new name already used by another client of the
 * office answers 409 { error: 'לקוח בשם זה כבר קיים במשרד', field: 'name' } (QA round 8, same check as
 * POST /api/clients). Answers { client }.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await requireClientAccess(id);
  if (!access.ok) return access.response;

  let body: { name?: unknown; vatAccount?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'גוף הבקשה אינו JSON תקין' }, { status: 400 });
  }
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'גוף הבקשה אינו תקין' }, { status: 400 });

  try {
    const result = await updateClientRecord(serviceClientRecordsDb(), {
      id,
      orgId: access.value.orgId,
      name: body.name,
      vatAccount: body.vatAccount,
    });
    if (!result.ok) return NextResponse.json({ error: result.error, field: result.field }, { status: result.status });
    return NextResponse.json({ client: result.client });
  } catch (err) {
    console.error(`[clients/${id}] PATCH failed:`, err);
    return NextResponse.json({ error: 'עדכון הלקוח נכשל' }, { status: 500 });
  }
}

/**
 * DELETE /api/clients/[id]: deletes a client and its stored files (QA round 4 #1). Office owners
 * only (403 otherwise). A client is deleted only while all its invoices failed processing or await
 * review, none was ever exported, none has status audit history and no bank statement was imported
 * (409 with the reason otherwise: approved / exported books are never wiped). The rule lives in the DB
 * (delete_client_guarded, migration 20261031101000_qa4_client_delete_guard.sql). Browser sessions have
 * no delete policy on clients, so this route (which also removes the stored files) is the only way.
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
