import { NextResponse } from 'next/server';
import type { User } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import { hasOrgAccess, loadMemberships, requireOrgOwner, requireUser, type AuthContext } from '@/lib/auth';
import { canRemoveMember, normalizeEmail, parseMemberRole, type MemberRole } from '@/shared/authModel';

export const dynamic = 'force-dynamic';

/**
 * Organization members (docs/auth.md).
 *   GET    ?orgId=           members + pending invitations (any member)
 *   POST   { email, orgId?, role? }   owner only: add an existing confirmed user, or invite by email
 *   DELETE ?orgId=&userId=   owner only: remove a member (never the last owner)
 *   DELETE ?orgId=&email=    owner only: cancel a pending invitation
 * orgId defaults to the caller's first organization.
 */

const MAX_USER_PAGES = 20;
const USERS_PER_PAGE = 1000;

function mockUnavailable() {
  return NextResponse.json({ error: 'ניהול משתמשים אינו זמין במצב סימולציה מקומי' }, { status: 400 });
}

async function resolveOrgId(ctx: AuthContext, requested: unknown): Promise<string | null> {
  if (typeof requested === 'string' && requested) return requested;
  const memberships = await loadMemberships(ctx);
  return memberships[0]?.orgId ?? null;
}

/** Finds an auth user by email via the admin API (service role). */
async function findUserByEmail(email: string): Promise<User | null> {
  for (let page = 1; page <= MAX_USER_PAGES; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: USERS_PER_PAGE });
    if (error) throw new Error(`Failed to list users: ${error.message}`);
    const users = data?.users ?? [];
    const match = users.find((u) => (u.email ?? '').toLowerCase() === email);
    if (match) return match;
    if (users.length < USERS_PER_PAGE) return null;
  }
  return null;
}

export async function GET(request: Request) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  if (auth.value.mock) return mockUnavailable();

  try {
    const orgId = await resolveOrgId(auth.value, new URL(request.url).searchParams.get('orgId'));
    if (!orgId || !(await hasOrgAccess(auth.value, orgId))) {
      return NextResponse.json({ error: 'אין הרשאה למשרד זה' }, { status: 403 });
    }

    const [{ data: rows, error }, { data: invites, error: invitesErr }] = await Promise.all([
      supabase.from('memberships').select('user_id, role, created_at').eq('org_id', orgId).order('created_at'),
      supabase.from('org_invitations').select('email, role, created_at').eq('org_id', orgId).order('created_at'),
    ]);
    if (error) throw new Error(`Failed to load members: ${error.message}`);
    if (invitesErr) throw new Error(`Failed to load invitations: ${invitesErr.message}`);

    const members = await Promise.all(
      ((rows ?? []) as { user_id: string; role: MemberRole; created_at: string }[]).map(async (m) => {
        const { data } = await supabase.auth.admin.getUserById(m.user_id);
        return { userId: m.user_id, email: data?.user?.email ?? null, role: m.role, createdAt: m.created_at };
      })
    );
    return NextResponse.json({ orgId, members, invitations: invites ?? [] });
  } catch (err) {
    console.error('[org/members] GET failed:', err);
    return NextResponse.json({ error: 'טעינת משתמשי המשרד נכשלה, נסו שוב' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  if (auth.value.mock) return mockUnavailable();

  try {
    const body = ((await request.json().catch(() => ({}))) ?? {}) as { email?: unknown; orgId?: unknown; role?: unknown };
    const email = normalizeEmail(body.email);
    const role = parseMemberRole(body.role);
    if (!email) return NextResponse.json({ error: 'כתובת אימייל לא תקינה' }, { status: 400 });
    if (!role) return NextResponse.json({ error: 'תפקיד לא תקין' }, { status: 400 });

    const owner = await requireOrgOwner(await resolveOrgId(auth.value, body.orgId), auth.value);
    if (!owner.ok) return owner.response;
    const { orgId } = owner.value;

    const existing = await findUserByEmail(email);
    // Attach directly only to a confirmed account; otherwise record an invitation that the DB
    // trigger claims when this email is confirmed (so nobody gets in by signing up with an email
    // they don't own).
    if (existing?.email_confirmed_at) {
      const { error } = await supabase.from('memberships').insert({ org_id: orgId, user_id: existing.id, role });
      if (error?.code === '23505') return NextResponse.json({ error: 'המשתמש כבר חבר במשרד' }, { status: 409 });
      if (error) throw new Error(`Failed to add member: ${error.message}`);
      return NextResponse.json({ status: 'added', email, role }, { status: 201 });
    }

    const { error: inviteRowErr } = await supabase
      .from('org_invitations')
      .upsert({ org_id: orgId, email, role, invited_by: auth.value.user.id }, { onConflict: 'org_id,email' });
    if (inviteRowErr) throw new Error(`Failed to record invitation: ${inviteRowErr.message}`);

    if (!existing) {
      const origin = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/+$/, '') || new URL(request.url).origin;
      const { error: inviteErr } = await supabase.auth.admin.inviteUserByEmail(email, {
        redirectTo: `${origin}/auth/callback?next=/clients`,
      });
      if (inviteErr) {
        await supabase.from('org_invitations').delete().eq('org_id', orgId).eq('email', email);
        console.error('[org/members] Invite email failed:', inviteErr.message);
        return NextResponse.json({ error: 'שליחת מייל ההזמנה נכשלה, נסו שוב מאוחר יותר' }, { status: 502 });
      }
    }
    // An existing but unconfirmed account joins once it confirms its email.
    return NextResponse.json({ status: 'invited', email, role }, { status: 201 });
  } catch (err) {
    console.error('[org/members] POST failed:', err);
    return NextResponse.json({ error: 'הוספת המשתמש נכשלה, נסו שוב' }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  if (auth.value.mock) return mockUnavailable();

  try {
    const params = new URL(request.url).searchParams;
    const owner = await requireOrgOwner(await resolveOrgId(auth.value, params.get('orgId')), auth.value);
    if (!owner.ok) return owner.response;
    const { orgId } = owner.value;

    const inviteEmail = normalizeEmail(params.get('email'));
    if (inviteEmail) {
      const { error } = await supabase.from('org_invitations').delete().eq('org_id', orgId).eq('email', inviteEmail);
      if (error) throw new Error(`Failed to cancel invitation: ${error.message}`);
      return NextResponse.json({ success: true });
    }

    const userId = params.get('userId');
    if (!userId) return NextResponse.json({ error: 'חסר משתמש' }, { status: 400 });

    const { data: rows, error } = await supabase.from('memberships').select('user_id, role').eq('org_id', orgId);
    if (error) throw new Error(`Failed to load members: ${error.message}`);
    const members = ((rows ?? []) as { user_id: string; role: MemberRole }[]).map((m) => ({ userId: m.user_id, role: m.role }));
    const check = canRemoveMember(members, userId);
    if (!check.ok) {
      return check.reason === 'last_owner'
        ? NextResponse.json({ error: 'לא ניתן להסיר את הבעלים האחרון של המשרד' }, { status: 409 })
        : NextResponse.json({ error: 'המשתמש אינו חבר במשרד' }, { status: 404 });
    }

    const { error: delErr } = await supabase.from('memberships').delete().eq('org_id', orgId).eq('user_id', userId);
    if (delErr) throw new Error(`Failed to remove member: ${delErr.message}`);
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('[org/members] DELETE failed:', err);
    return NextResponse.json({ error: 'ההסרה נכשלה, נסו שוב' }, { status: 500 });
  }
}
