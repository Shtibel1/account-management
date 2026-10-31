import { NextResponse } from 'next/server';
import { hasOrgAccess, loadMemberships, requireUser } from '@/lib/auth';
import { createClientRecord } from '@/lib/clientRecords';
import { serviceClientRecordsDb } from '@/lib/clientRecordsDb';

export const dynamic = 'force-dynamic';

/**
 * POST /api/clients { name, vatAccount?, orgId? }: creates a client in the user's office (orgId, or
 * the oldest membership like the clients page) with the default category mappings. A name already
 * used by another client of that office answers 409 { error: 'לקוח בשם זה כבר קיים במשרד', field: 'name' }
 * (QA round 8). Answers 201 { client }.
 */
export async function POST(request: Request) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  const ctx = auth.value;

  let body: { name?: unknown; vatAccount?: unknown; orgId?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'גוף הבקשה אינו JSON תקין' }, { status: 400 });
  }
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'גוף הבקשה אינו תקין' }, { status: 400 });

  try {
    let orgId: string | null = null;
    if (!ctx.mock) {
      if (body.orgId !== undefined && body.orgId !== null && body.orgId !== '') {
        if (typeof body.orgId !== 'string' || !(await hasOrgAccess(ctx, body.orgId))) {
          return NextResponse.json({ error: 'אין הרשאה למשרד זה' }, { status: 403 });
        }
        orgId = body.orgId;
      } else {
        orgId = (await loadMemberships(ctx))[0]?.orgId ?? null;
        if (!orgId) return NextResponse.json({ error: 'המשתמש אינו משויך למשרד' }, { status: 403 });
      }
    }

    const result = await createClientRecord(serviceClientRecordsDb(), { orgId, name: body.name, vatAccount: body.vatAccount });
    if (!result.ok) return NextResponse.json({ error: result.error, field: result.field }, { status: result.status });
    return NextResponse.json({ client: result.client }, { status: 201 });
  } catch (err) {
    console.error('[clients] POST failed:', err);
    return NextResponse.json({ error: 'יצירת הלקוח נכשלה' }, { status: 500 });
  }
}
