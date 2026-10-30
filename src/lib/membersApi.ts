// Client helpers for office member management (GET/POST/DELETE /api/org/members, docs/auth.md).
import type { MemberRole } from '@/shared/authModel';

export interface OrgMember {
  userId: string;
  email: string | null;
  role: MemberRole;
  createdAt: string;
}

export interface OrgInvitation {
  email: string;
  role: MemberRole;
  created_at: string;
}

export interface OrgMembersResponse {
  orgId: string;
  members: OrgMember[];
  invitations: OrgInvitation[];
}

export interface InviteMemberResponse {
  status: 'added' | 'invited';
  email: string;
  role: MemberRole;
}

async function request<T>(url: string, fallbackError: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      cache: 'no-store',
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch {
    throw new Error('אין חיבור לשרת, נסו שוב');
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(typeof body?.error === 'string' && body.error ? body.error : fallbackError);
  return body as T;
}

const orgQuery = (orgId: string | null) => (orgId ? `orgId=${encodeURIComponent(orgId)}` : '');

export function fetchOrgMembers(orgId: string | null) {
  const qs = orgQuery(orgId);
  return request<OrgMembersResponse>(`/api/org/members${qs ? `?${qs}` : ''}`, 'שגיאה בטעינת משתמשי המשרד');
}

export function inviteOrgMember(orgId: string | null, email: string, role: MemberRole) {
  return request<InviteMemberResponse>('/api/org/members', 'שליחת ההזמנה נכשלה', {
    method: 'POST',
    body: JSON.stringify({ orgId, email, role }),
  });
}

export function removeOrgMember(orgId: string | null, userId: string) {
  const params = new URLSearchParams({ userId });
  if (orgId) params.set('orgId', orgId);
  return request<{ success: true }>(`/api/org/members?${params}`, 'הסרת המשתמש נכשלה', { method: 'DELETE' });
}

export function cancelOrgInvitation(orgId: string | null, email: string) {
  const params = new URLSearchParams({ email });
  if (orgId) params.set('orgId', orgId);
  return request<{ success: true }>(`/api/org/members?${params}`, 'ביטול ההזמנה נכשל', { method: 'DELETE' });
}

/** Loose client-side email check (the server normalizes and validates again). */
export function isPlausibleEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

export const ROLE_LABELS: Record<MemberRole, string> = { owner: 'בעלים', member: 'חבר צוות' };
