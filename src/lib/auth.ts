import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import { createClient as createSessionClient } from '@/utils/supabase/server';
import { isMisconfiguredProduction, isMockMode, MISCONFIGURED_MESSAGE } from '@/lib/supabaseConfig';

/**
 * Route guards for API handlers. Every non-public API route resolves the signed-in user and checks
 * that the resource it touches belongs to an organization the user is a member of, BEFORE using the
 * service-role client (which bypasses RLS). Never trust clientId / tenantId from the request body
 * without one of these checks.
 *
 * Usage:
 *   const access = await requireClientAccess(clientId);
 *   if (!access.ok) return access.response;      // 401 / 403 / 404 / 503
 *
 * Mock mode (local dev without Supabase env) skips auth: a fixed mock user may access everything.
 * In production without Supabase env every guard fails closed with 503.
 */

export type OrgRole = 'owner' | 'member';

export interface AuthUser {
  id: string;
  email: string | null;
}

export interface OrgMembership {
  orgId: string;
  role: OrgRole;
}

export interface AuthContext {
  user: AuthUser;
  /** True in local mock mode: no real auth, every resource is accessible. */
  mock: boolean;
  /** Lazily loaded memberships of the user (cached per request). */
  memberships?: OrgMembership[];
}

export type Guard<T> = { ok: true; value: T } | { ok: false; response: NextResponse };

export const MOCK_USER: AuthUser = { id: '00000000-0000-4000-8000-00000000000a', email: 'mock@localhost' };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function deny(status: 401 | 403 | 404 | 503, error: string): { ok: false; response: NextResponse } {
  return { ok: false, response: NextResponse.json({ error }, { status }) };
}

function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value };
}

const MSG_UNAUTHENTICATED = 'נדרשת התחברות';

/** Dependencies (swappable in scratch tests; production always uses the defaults). */
interface AuthDeps {
  /** Service-role client used for the membership lookups. */
  db: SupabaseClient;
  /** Validated user of the current request's cookie session, or null. */
  getSessionUser: () => Promise<AuthUser | null>;
}

async function defaultGetSessionUser(): Promise<AuthUser | null> {
  const session = await createSessionClient();
  const { data, error } = await session.auth.getUser();
  if (error || !data?.user) return null;
  return { id: data.user.id, email: data.user.email ?? null };
}

const deps: AuthDeps = { db: supabase, getSessionUser: defaultGetSessionUser };

/** Test hook: replace the DB / session resolver. Not used by the app. */
export function setAuthDependenciesForTests(overrides: Partial<AuthDeps>): void {
  Object.assign(deps, overrides);
}
const MSG_FORBIDDEN = 'אין הרשאה למשאב זה';

/** Resolves the signed-in user from the cookie session (validated with Supabase Auth). */
export async function requireUser(): Promise<Guard<AuthContext>> {
  if (isMisconfiguredProduction()) return deny(503, MISCONFIGURED_MESSAGE);
  if (isMockMode()) return ok({ user: MOCK_USER, mock: true, memberships: [] });

  try {
    const user = await deps.getSessionUser();
    if (!user) return deny(401, MSG_UNAUTHENTICATED);
    return ok({ user, mock: false });
  } catch (err) {
    console.error('[auth] Failed to resolve the session user:', err);
    return deny(401, MSG_UNAUTHENTICATED);
  }
}

/** The user's organization memberships (service role; cached on the context). */
export async function loadMemberships(ctx: AuthContext): Promise<OrgMembership[]> {
  if (ctx.mock) return [];
  if (ctx.memberships) return ctx.memberships;
  const { data, error } = await deps.db
    .from('memberships')
    .select('org_id, role, created_at')
    .eq('user_id', ctx.user.id)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`Failed to load memberships: ${error.message}`);
  ctx.memberships = ((data ?? []) as { org_id: string; role: OrgRole }[]).map((m) => ({ orgId: m.org_id, role: m.role }));
  return ctx.memberships;
}

export async function hasOrgAccess(ctx: AuthContext, orgId: string | null | undefined, role?: OrgRole): Promise<boolean> {
  if (ctx.mock) return true;
  if (!orgId) return false;
  const memberships = await loadMemberships(ctx);
  return memberships.some((m) => m.orgId === orgId && (!role || m.role === role));
}

/**
 * Ids of all clients the user may access, or null in mock mode (= no filter). For list endpoints
 * that aren't scoped to one client.
 */
export async function accessibleClientIds(ctx: AuthContext): Promise<string[] | null> {
  if (ctx.mock) return null;
  const orgIds = (await loadMemberships(ctx)).map((m) => m.orgId);
  if (orgIds.length === 0) return [];
  const { data, error } = await deps.db.from('clients').select('id').in('org_id', orgIds);
  if (error) throw new Error(`Failed to load accessible clients: ${error.message}`);
  return ((data ?? []) as { id: string }[]).map((c) => c.id);
}

export interface ClientAccess {
  ctx: AuthContext;
  clientId: string;
  orgId: string | null;
}

/** Wraps unexpected failures of a guard so the route answers 500 instead of crashing. */
async function guarded<T>(label: string, fn: () => Promise<Guard<T>>): Promise<Guard<T>> {
  try {
    return await fn();
  } catch (err) {
    console.error(`[auth] ${label} failed:`, err);
    return { ok: false, response: NextResponse.json({ error: 'שגיאה בבדיקת הרשאות' }, { status: 500 }) };
  }
}

async function checkClient(ctx: AuthContext, clientId: unknown): Promise<Guard<ClientAccess>> {
  if (ctx.mock) {
    if (typeof clientId !== 'string' || !clientId) return deny(404, 'לקוח לא נמצא');
    return ok({ ctx, clientId, orgId: null });
  }
  if (!isUuid(clientId)) return deny(404, 'לקוח לא נמצא');

  const { data, error } = await deps.db.from('clients').select('id, org_id').eq('id', clientId).maybeSingle();
  if (error) throw new Error(`Client lookup failed: ${error.message}`);
  if (!data) return deny(404, 'לקוח לא נמצא');

  const orgId = (data as { org_id: string | null }).org_id;
  if (!(await hasOrgAccess(ctx, orgId))) return deny(403, MSG_FORBIDDEN);
  return ok({ ctx, clientId, orgId });
}

/** Signed-in user + the client belongs to one of the user's organizations. */
export async function requireClientAccess(clientId: unknown, existing?: AuthContext): Promise<Guard<ClientAccess>> {
  const auth = existing ? ok(existing) : await requireUser();
  if (!auth.ok) return auth;
  return guarded('Client access check', () => checkClient(auth.value, clientId));
}

/** Checks several clients at once (e.g. export of invoices). All must be accessible. */
export async function requireClientsAccess(clientIds: string[], existing?: AuthContext): Promise<Guard<AuthContext>> {
  const auth = existing ? ok(existing) : await requireUser();
  if (!auth.ok) return auth;
  const ctx = auth.value;
  return guarded('Clients access check', async () => {
    for (const id of [...new Set(clientIds)]) {
      const res = await checkClient(ctx, id);
      if (!res.ok) return res;
    }
    return ok(ctx);
  });
}

export interface InvoiceAccess<T extends Record<string, unknown>> extends ClientAccess {
  invoice: T;
}

/**
 * Signed-in user + the invoice's client belongs to one of the user's organizations.
 * `columns` must include client_id (default: 'id, client_id').
 */
export async function requireInvoiceAccess<T extends Record<string, unknown> = { id: string; client_id: string }>(
  invoiceId: unknown,
  columns: string = 'id, client_id',
  existing?: AuthContext
): Promise<Guard<InvoiceAccess<T>>> {
  const auth = existing ? ok(existing) : await requireUser();
  if (!auth.ok) return auth;
  const ctx = auth.value;

  return guarded('Invoice access check', async () => {
    if (typeof invoiceId !== 'string' || !invoiceId || (!ctx.mock && !isUuid(invoiceId))) {
      return deny(404, 'החשבונית לא נמצאה');
    }
    const { data, error } = await deps.db.from('invoices').select(columns).eq('id', invoiceId).single();
    if (error || !data) return deny(404, 'החשבונית לא נמצאה');
    const invoice = data as unknown as T;
    const client = await checkClient(ctx, invoice.client_id);
    if (!client.ok) {
      // The invoice exists but its client isn't the user's: don't reveal more than "forbidden".
      return client.response.status === 404 ? deny(403, MSG_FORBIDDEN) : client;
    }
    return ok({ ...client.value, invoice });
  });
}

export interface BankTransactionAccess extends ClientAccess {
  transactionId: string;
}

export async function requireBankTransactionAccess(transactionId: unknown, existing?: AuthContext): Promise<Guard<BankTransactionAccess>> {
  const auth = existing ? ok(existing) : await requireUser();
  if (!auth.ok) return auth;
  const ctx = auth.value;

  return guarded('Bank transaction access check', async () => {
    if (typeof transactionId !== 'string' || !transactionId || (!ctx.mock && !isUuid(transactionId))) {
      return deny(404, 'התנועה לא נמצאה');
    }
    if (ctx.mock) return ok({ ctx, clientId: '', orgId: null, transactionId });
    const { data, error } = await deps.db
      .from('bank_transactions')
      .select('id, client_id')
      .eq('id', transactionId)
      .maybeSingle();
    if (error) throw new Error(`Bank transaction lookup failed: ${error.message}`);
    if (!data) return deny(404, 'התנועה לא נמצאה');
    const client = await checkClient(ctx, (data as { client_id: string }).client_id);
    if (!client.ok) return client.response.status === 404 ? deny(403, MSG_FORBIDDEN) : client;
    return ok({ ...client.value, transactionId });
  });
}

/** Signed-in owner of the organization. */
export async function requireOrgOwner(orgId: unknown, existing?: AuthContext): Promise<Guard<{ ctx: AuthContext; orgId: string }>> {
  const auth = existing ? ok(existing) : await requireUser();
  if (!auth.ok) return auth;
  const ctx = auth.value;
  return guarded('Org owner check', async () => {
    if (!isUuid(orgId)) return deny(404, 'המשרד לא נמצא');
    if (!(await hasOrgAccess(ctx, orgId))) return deny(403, MSG_FORBIDDEN);
    if (!(await hasOrgAccess(ctx, orgId, 'owner'))) return deny(403, 'רק בעלי המשרד יכולים לבצע פעולה זו');
    return ok({ ctx, orgId });
  });
}
