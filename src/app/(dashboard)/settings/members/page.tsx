'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Mail, ShieldAlert, Trash2, UserCog, UserPlus, X } from 'lucide-react';
import clsx from 'clsx';
import { useSession } from '@/components/Auth/SessionContext';
import { useToast } from '@/components/ui/Toast';
import { useConfirm } from '@/components/ui/ConfirmDialog';
import type { MemberRole } from '@/shared/authModel';
import {
  cancelOrgInvitation,
  fetchOrgMembers,
  inviteOrgMember,
  isPlausibleEmail,
  removeOrgMember,
  ROLE_LABELS,
  type OrgMembersResponse,
} from '@/lib/membersApi';

/** "משתמשי המשרד": members list for everyone in the office; owners invite and remove (docs/auth.md). */
export default function OrgMembersPage() {
  const { me, loading: sessionLoading, currentOrgId } = useSession();
  const { toast } = useToast();
  const askConfirm = useConfirm();

  const orgs = useMemo(() => me?.organizations ?? [], [me]);
  const [orgId, setOrgId] = useState<string | null>(null);
  const [data, setData] = useState<OrgMembersResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [email, setEmail] = useState('');
  const [role, setRole] = useState<MemberRole>('member');
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  useEffect(() => {
    if (orgId || orgs.length === 0) return;
    setOrgId(orgs.find((o) => o.id === currentOrgId)?.id ?? orgs[0].id);
  }, [orgs, currentOrgId, orgId]);

  const isOwner = orgs.find((o) => o.id === orgId)?.role === 'owner';

  // The office currently shown: a response for an office switched away from is dropped
  const shownOrgId = useRef<string | null>(null);
  useEffect(() => { shownOrgId.current = orgId; }, [orgId]);

  const load = useCallback(async (id: string) => {
    setError(null);
    try {
      const result = await fetchOrgMembers(id);
      if (shownOrgId.current === id) setData(result);
    } catch (err) {
      console.error('[settings/members] Failed to load members:', err);
      if (shownOrgId.current !== id) return;
      setData(null);
      setError(err instanceof Error ? err.message : 'שגיאה בטעינת משתמשי המשרד');
    }
  }, []);

  useEffect(() => { if (orgId) { setData(null); load(orgId); } }, [orgId, load]);

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!orgId || inviting) return;
    const address = email.trim();
    if (!isPlausibleEmail(address)) {
      setInviteError('כתובת אימייל לא תקינה');
      return;
    }
    setInviting(true);
    setInviteError(null);
    try {
      const res = await inviteOrgMember(orgId, address, role);
      toast(res.status === 'added' ? `${res.email} נוסף/ה למשרד` : `נשלחה הזמנה אל ${res.email}`, 'success');
      setEmail('');
      setRole('member');
      await load(orgId);
    } catch (err) {
      setInviteError(err instanceof Error ? err.message : 'שליחת ההזמנה נכשלה');
    } finally {
      setInviting(false);
    }
  };

  const handleRemove = async (userId: string, label: string) => {
    if (!orgId) return;
    if (!(await askConfirm({ title: 'הסרת משתמש', message: `להסיר את ${label} מהמשרד? הגישה שלו/ה לנתוני המשרד תיחסם מיד.`, confirmLabel: 'הסר', tone: 'danger' }))) return;
    setBusyKey(`member:${userId}`);
    try {
      await removeOrgMember(orgId, userId);
      toast('המשתמש הוסר מהמשרד', 'success');
      await load(orgId);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'הסרת המשתמש נכשלה', 'error');
    } finally {
      setBusyKey(null);
    }
  };

  const handleCancelInvite = async (address: string) => {
    if (!orgId) return;
    if (!(await askConfirm({ title: 'ביטול הזמנה', message: `לבטל את ההזמנה של ${address}?`, confirmLabel: 'בטל הזמנה', cancelLabel: 'חזרה', tone: 'danger' }))) return;
    setBusyKey(`invite:${address}`);
    try {
      await cancelOrgInvitation(orgId, address);
      toast('ההזמנה בוטלה', 'success');
      await load(orgId);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'ביטול ההזמנה נכשל', 'error');
    } finally {
      setBusyKey(null);
    }
  };

  if (sessionLoading) {
    return <div className="flex items-center justify-center py-24 text-slate-400"><Loader2 className="h-7 w-7 animate-spin" /></div>;
  }

  if (me?.mock) {
    return (
      <div className="card p-6 max-w-2xl text-sm text-slate-600">
        ניהול משתמשים אינו זמין במצב סימולציה מקומי.
      </div>
    );
  }

  if (orgs.length === 0) {
    return (
      <div className="card p-6 max-w-2xl flex items-start gap-3 text-sm text-slate-600">
        <ShieldAlert className="h-5 w-5 text-amber-500 shrink-0" />
        אינך משויך/ת למשרד.
      </div>
    );
  }

  const ownerCount = data?.members.filter((m) => m.role === 'owner').length ?? 0;

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
            <UserCog className="h-6 w-6 text-blue-600" /> משתמשי המשרד
          </h2>
          <p className="text-sm text-slate-500 mt-1">
            {isOwner ? 'הזמנת עובדים למשרד והסרתם. לכל חברי המשרד יש גישה לכל לקוחות המשרד.' : 'רק בעלי המשרד יכולים להזמין או להסיר משתמשים.'}
          </p>
        </div>
        {orgs.length > 1 && (
          <div className="flex items-center gap-2">
            <label htmlFor="members-org" className="text-sm text-slate-600">משרד:</label>
            <select
              id="members-org"
              value={orgId ?? ''}
              onChange={(e) => setOrgId(e.target.value)}
              className="input-base py-2 max-w-[14rem]"
            >
              {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </div>
        )}
      </div>

      {isOwner && (
        <form onSubmit={handleInvite} className="card p-4 sm:p-5 space-y-3" noValidate>
          <h3 className="font-semibold text-slate-900 flex items-center gap-2">
            <UserPlus className="h-4 w-4 text-blue-600" /> הזמנת משתמש
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_10rem_auto] gap-3 items-end">
            <div>
              <label htmlFor="invite-email" className="block text-sm font-medium text-slate-700 mb-1.5">אימייל</label>
              <input
                id="invite-email"
                type="email"
                dir="ltr"
                autoComplete="off"
                value={email}
                onChange={(e) => { setEmail(e.target.value); setInviteError(null); }}
                placeholder="name@example.com"
                aria-invalid={!!inviteError || undefined}
                aria-describedby={inviteError ? 'invite-error' : undefined}
                className={clsx('input-base text-left', inviteError && 'input-error')}
              />
            </div>
            <div>
              <label htmlFor="invite-role" className="block text-sm font-medium text-slate-700 mb-1.5">תפקיד</label>
              <select id="invite-role" value={role} onChange={(e) => setRole(e.target.value as MemberRole)} className="input-base">
                <option value="member">{ROLE_LABELS.member}</option>
                <option value="owner">{ROLE_LABELS.owner}</option>
              </select>
            </div>
            <button
              type="submit"
              disabled={inviting || !email.trim()}
              className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-5 py-2.5 rounded-xl text-sm font-semibold transition-colors flex items-center justify-center gap-2"
            >
              {inviting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />}
              {inviting ? 'שולח...' : 'הזמן'}
            </button>
          </div>
          {inviteError && <p id="invite-error" className="text-sm text-red-600">{inviteError}</p>}
          <p className="text-xs text-slate-500">
            משתמש קיים מצורף מיד. כתובת חדשה מקבלת הזמנה במייל, והגישה למשרד נפתחת אחרי אישור הכתובת.
          </p>
        </form>
      )}

      {error && <div className="p-4 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">{error}</div>}

      {!data && !error ? (
        <div className="flex items-center justify-center py-16 text-slate-400"><Loader2 className="h-6 w-6 animate-spin" /></div>
      ) : data ? (
        <>
          <section className="card overflow-hidden">
            <div className="px-5 py-3 border-b border-slate-100 bg-slate-50">
              <h3 className="font-semibold text-slate-900">חברי המשרד ({data.members.length})</h3>
            </div>
            <ul className="divide-y divide-slate-100">
              {data.members.map((m) => {
                const isSelf = m.userId === me?.user.id;
                const label = m.email ?? 'משתמש';
                const lastOwner = m.role === 'owner' && ownerCount <= 1;
                return (
                  <li key={m.userId} className="px-5 py-3 flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-slate-800 truncate" dir="ltr" style={{ textAlign: 'right' }}>{label}</p>
                      <p className="text-xs text-slate-500">
                        {ROLE_LABELS[m.role]}{isSelf ? ' · את/ה' : ''}
                      </p>
                    </div>
                    {isOwner && (
                      <button
                        type="button"
                        onClick={() => handleRemove(m.userId, label)}
                        disabled={lastOwner || busyKey === `member:${m.userId}`}
                        title={lastOwner ? 'לא ניתן להסיר את הבעלים האחרון של המשרד' : 'הסר מהמשרד'}
                        aria-label={`הסר את ${label} מהמשרד`}
                        className="text-slate-400 hover:text-red-600 disabled:opacity-40 disabled:hover:text-slate-400 p-1.5 rounded-lg transition-colors"
                      >
                        {busyKey === `member:${m.userId}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>

          {data.invitations.length > 0 && (
            <section className="card overflow-hidden">
              <div className="px-5 py-3 border-b border-slate-100 bg-slate-50">
                <h3 className="font-semibold text-slate-900">הזמנות ממתינות ({data.invitations.length})</h3>
              </div>
              <ul className="divide-y divide-slate-100">
                {data.invitations.map((inv) => (
                  <li key={inv.email} className="px-5 py-3 flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-slate-800 truncate" dir="ltr" style={{ textAlign: 'right' }}>{inv.email}</p>
                      <p className="text-xs text-slate-500">{ROLE_LABELS[inv.role] ?? inv.role} · ממתין/ה לאישור הכתובת</p>
                    </div>
                    {isOwner && (
                      <button
                        type="button"
                        onClick={() => handleCancelInvite(inv.email)}
                        disabled={busyKey === `invite:${inv.email}`}
                        title="בטל הזמנה"
                        aria-label={`בטל את ההזמנה של ${inv.email}`}
                        className="text-slate-400 hover:text-red-600 disabled:opacity-40 p-1.5 rounded-lg transition-colors"
                      >
                        {busyKey === `invite:${inv.email}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      ) : null}
    </div>
  );
}
