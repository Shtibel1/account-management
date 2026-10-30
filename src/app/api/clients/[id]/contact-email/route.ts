import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { requireClientAccess } from '@/lib/auth';
import { requireFeature } from '@/lib/featureFlags';
import { normalizeEmail } from '@/shared/authModel';

export const dynamic = 'force-dynamic';

/**
 * The client's email for "returned to client" notifications (clients.contact_email).
 * accountant_review_loop only (404 while it is off for the office).
 *   GET               → { contactEmail }
 *   PUT { email }     email string, or null / '' to clear → { contactEmail }
 */

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await requireClientAccess(id);
  if (!access.ok) return access.response;
  const gate = await requireFeature(access.value.orgId, 'accountant_review_loop');
  if (gate) return gate;

  try {
    const { data, error } = await supabase.from('clients').select('*').eq('id', id).limit(1);
    if (error) throw new Error(error.message);
    const row = (Array.isArray(data) ? data[0] : null) as { contact_email?: string | null } | undefined;
    return NextResponse.json({ contactEmail: row?.contact_email ?? null });
  } catch (err) {
    console.error(`[clients/contact-email] Failed to load for client ${id}:`, err);
    return NextResponse.json({ error: 'שגיאה בטעינת כתובת האימייל' }, { status: 500 });
  }
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await requireClientAccess(id);
  if (!access.ok) return access.response;
  const gate = await requireFeature(access.value.orgId, 'accountant_review_loop');
  if (gate) return gate;

  let body: { email?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'גוף הבקשה אינו JSON תקין' }, { status: 400 });
  }
  const raw = body?.email;
  let email: string | null = null;
  if (raw !== null && raw !== undefined && raw !== '') {
    email = normalizeEmail(raw);
    if (!email) return NextResponse.json({ error: 'כתובת אימייל לא תקינה' }, { status: 400 });
  }

  try {
    const { error } = await supabase
      .from('clients')
      .update({ contact_email: email })
      .eq('id', id);
    if (error) throw new Error(error.message);
    return NextResponse.json({ contactEmail: email });
  } catch (err) {
    console.error(`[clients/contact-email] Failed to save for client ${id}:`, err);
    return NextResponse.json({ error: 'שגיאה בשמירת כתובת האימייל' }, { status: 500 });
  }
}
