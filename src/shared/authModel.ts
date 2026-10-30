/** Pure helpers for the auth / organization model (see docs/auth.md). */

export type MemberRole = 'owner' | 'member';

/** GET /api/me */
export interface MeResponse {
  mock: boolean;
  user: { id: string; email: string | null };
  organizations: { id: string; name: string; role: MemberRole }[];
  /** The organization new clients are created in (the oldest membership). */
  currentOrgId: string | null;
}

/** Lower-cased, trimmed email or null when it isn't a plausible address. */
export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (email.length < 3 || email.length > 254) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

export function parseMemberRole(value: unknown): MemberRole | null {
  if (value === undefined || value === null || value === '') return 'member';
  return value === 'owner' || value === 'member' ? value : null;
}

/** Owners can't remove the last owner of an organization (it would be unmanageable). */
export function canRemoveMember(
  members: { userId: string; role: MemberRole }[],
  targetUserId: string
): { ok: true } | { ok: false; reason: 'not_member' | 'last_owner' } {
  const target = members.find((m) => m.userId === targetUserId);
  if (!target) return { ok: false, reason: 'not_member' };
  if (target.role === 'owner' && members.filter((m) => m.role === 'owner').length <= 1) {
    return { ok: false, reason: 'last_owner' };
  }
  return { ok: true };
}
