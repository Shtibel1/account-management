# Authentication & office (organization) tenancy

Migration: `supabase/migrations/20261030140000_auth_tenancy.sql`. Code: `src/proxy.ts`, `src/lib/auth.ts`,
`src/lib/routeAccess.ts`, `src/lib/supabaseConfig.ts`, `src/app/(auth)/{login,signup}`, `src/app/auth/{callback,complete}`,
`src/app/api/me`, `src/app/api/org/members`.

## Model

```
auth.users ──< memberships (role owner|member) >── organizations ──< clients ──< invoices, account_mappings,
                                                                               supplier_automation, client_contacts,
                                                                               duplicate_dismissals, bank_transactions
                                                                    invoices ──< invoice_corrections
```

- **organization** = one bookkeeping office. **membership** = (org, user, role), unique per pair.
- Every **client** has `org_id` (NOT NULL). All other tenant tables are keyed by `client_id` (corrections by
  `invoice_id`) and inherit access through the client.
- The migration creates the office **"המשרד של נדב"** (fixed id `00000000-0000-4000-8000-000000000001`) and attaches
  every existing client to it.
- **Provisioning** (trigger `on_auth_user_provisioning` on `auth.users`, function `provision_user_memberships`) runs when
  a user's email becomes confirmed (immediately on insert if the project auto-confirms):
  - `nadavshtibel@gmail.com` → owner of "המשרד של נדב" (also applied by the migration if that user already exists);
  - pending `org_invitations` for that email → memberships (invitations are consumed);
  - any user still without a membership → a new organization named from signup metadata `org_name`
    (else `"המשרד של " + full_name`, else `"המשרד של " + <email local part>`), with the user as owner.
  Waiting for confirmation means nobody can claim the bootstrap owner or someone's invitation by signing up with an
  email they don't control. **Keep "Confirm email" enabled** in Supabase Auth settings.
- New clients created from the browser go to the creator's current office (`/api/me` → `currentOrgId`, the oldest
  membership); if `org_id` is omitted the `clients_default_org` trigger fills the same value.

## Row level security

- Every `allow_all_* to anon` policy is dropped (the migration drops **all** policies in `public` and re-creates the ones
  below), RLS is enabled on every public table, and `anon` loses all table / sequence / function privileges.
  `anon` gets nothing.
- `authenticated`:
  - `organizations`: select where `is_org_member(id)`; `memberships`: select own rows and rows of your orgs;
    `org_invitations`: select for owners. Writes only via the server (service role) / the trigger.
  - `clients`: all operations where `is_org_member(org_id)` (insert/update also *with check*).
  - `invoices`, `account_mappings`, `supplier_automation`, `client_contacts`: `client_id in (select accessible_client_ids())`.
  - `duplicate_dismissals`, `bank_transactions`: same, plus the referenced invoices must belong to the same client.
  - `invoice_corrections`: through the invoice.
- Helpers (all `security definer`, `stable`, `set search_path = ''`): `is_org_member(org)`, `is_org_owner(org)`,
  `accessible_client_ids()`, `can_access_storage_object(name)`.
- Views `field_accuracy`, `supplier_accuracy`, `fewshot_accuracy` stay `security_invoker` → scoped by the policies above.
- RPCs `find_duplicate_candidates` / `normalize_invoice_number`: execute for `authenticated` + `service_role` only.
- **Storage** `raw-invoices` (objects at `<client_id>/<file>`): bucket set to private; anon / allow-all policies dropped;
  `authenticated` may read/write only objects whose first folder is a client of their org. The app itself only touches
  the bucket server-side (service role: signed upload URLs, 1-year signed read URLs, pipeline uploads), so these
  policies are defense in depth. Signed URLs keep working on a private bucket.
- `update_updated_at`, `normalize_invoice_number`, `bank_transactions_before_update`: fixed `search_path`.
- `service_role` bypasses RLS: API routes (after their own access check), the LangGraph pipeline, and the ingestion
  webhooks (which resolve the client by inbound alias / WhatsApp phone, unchanged).

## Request flow

1. **Proxy** (`src/proxy.ts`, Next 16's renamed middleware) refreshes the Supabase cookie session on every request and:
   - lets public paths through: `/`, `/order`, `/privacy`, `/login`, `/signup`, `/auth/*`, `/api/lead`,
     `/api/ingest/email`, `/api/ingest/whatsapp` (webhooks keep their own secret / Twilio-signature auth), static files;
   - unauthenticated page → `307 /login?next=<path>`; unauthenticated `/api/*` → `401 {"error":"נדרשת התחברות"}`;
   - signed-in user on `/login` or `/signup` → redirected to `next` (default `/clients`).
   The list lives in `src/lib/routeAccess.ts` (`classifyPath`, `safeNextPath` - same-origin redirects only).
2. **Route guards** (`src/lib/auth.ts`) in every non-public API route:
   - `requireUser()` → 401 without a valid session (validated with `auth.getUser()`).
   - `requireClientAccess(clientId)`, `requireClientsAccess(ids)`, `requireInvoiceAccess(invoiceId, columns?)`,
     `requireBankTransactionAccess(id)`, `requireOrgOwner(orgId)` → 404 unknown / 403 not your office.
   - `accessibleClientIds(ctx)` for list endpoints without a client filter.
   Only after the check do routes use the service-role client. Body values are never trusted on their own:
   `/api/invoices/[id]/process` takes the file URL and client from the stored invoice (a mismatching `tenantId` → 403),
   and both it and `/split` only fetch a stored `file_url` that is a raw-invoices URL of our own Supabase project
   inside that invoice's `<clientId>/` folder (`isClientStorageFileUrl`; `file_url` is user-editable, so anything
   else would be SSRF / cross-office file access),
   `/api/invoices/upload` only registers storage paths inside `<clientId>/`, `PATCH /api/invoices/[id]` re-checks a
   changed `client_id`, `/api/export` requires all invoices to be accessible (and from one client).
3. **Browser** data access (`src/utils/supabase/client.ts`) uses the anon key + the user's cookie session, so RLS
   applies. The service key (`SUPABASE_SERVICE_KEY`, not `NEXT_PUBLIC_*`) is only read by `src/lib/supabase.ts`, which
   throws if evaluated in a browser.

## Login UI

- `/login`: email + password, or a magic link (`signInWithOtp`, existing accounts only).
- `/signup`: office name, full name, email, password → `auth.signUp` with `org_name` / `full_name` metadata; the
  trigger creates the office once the email is confirmed.
- `/auth/callback`: PKCE `?code=` and `?token_hash=&type=` links; implicit-flow links (tokens in the URL fragment, e.g.
  admin invites) continue to `/auth/complete`, which stores the session in the browser.
- Dashboard sidebar: office name, user email, **התנתקות** (logout).

## Supabase project settings (one-time)

- Auth → URL configuration: Site URL = production origin; add `https://<host>/auth/callback` (and
  `http://localhost:3001/auth/callback` for dev) to the redirect allow-list.
- Auth → Providers → Email: keep *Confirm email* on.
- Optional (works across browsers / devices): change the *Confirm signup*, *Magic link* and *Invite user* email
  templates to `{{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=<signup|magiclink|invite>&next=/clients`.
- Server env: `SUPABASE_SERVICE_KEY` **must** be set (Amplify). Without it the server falls back to the anon key, which
  has no access after this migration. Optional `NEXT_PUBLIC_SITE_URL` for invite redirects.

## Adding a member to an office

Owner-only API (`src/app/api/org/members/route.ts`); `orgId` defaults to the caller's first office:

```http
GET    /api/org/members?orgId=<uuid>                 # members (+ emails) and pending invitations
POST   /api/org/members  {"email":"x@y.co","role":"member"}
DELETE /api/org/members?orgId=<uuid>&userId=<uuid>   # remove a member (never the last owner)
DELETE /api/org/members?orgId=<uuid>&email=x@y.co    # cancel a pending invitation
```

`POST` behavior:
- the email belongs to a **confirmed** account → a membership is created immediately (`409` if already a member);
- otherwise an `org_invitations` row is stored; if no account exists, Supabase sends an invite email
  (`auth.admin.inviteUserByEmail`, redirect to `/auth/callback?next=/clients`). When the person confirms / accepts,
  the trigger turns the invitation into a membership (and no personal office is created for them). An invited user
  can later sign in with a magic link from `/login`.

Manual alternative (SQL editor, as the project owner):

```sql
insert into public.memberships (org_id, user_id, role)
select '<org uuid>', id, 'member' from auth.users where lower(email) = 'person@example.com';
```

## Local mock mode

Without `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` and **outside production**, the app uses the JSON
mock DB and skips auth entirely (as before): the proxy lets everything through, guards return a fixed mock user with
access to everything, `/api/mock-db` is served. With `NODE_ENV=production` and the env missing the app fails closed:
dashboard pages and `/api/*` answer `503`, the server DB client throws on use, `/api/mock-db` is `404`; only the
marketing pages, `/api/lead` and the webhooks (which then fail on DB access) are served.

## Applying the migration

Not applied automatically. Before applying to the live project:
1. Make sure `SUPABASE_SERVICE_KEY` is set in Amplify and deploy this branch right after (old code + new RLS = the
   browser's anon queries return nothing; new code + old RLS = the browser's `authenticated` queries return nothing).
2. Apply `20261030140000_auth_tenancy.sql`; then sign up / sign in as `nadavshtibel@gmail.com` and check that
   `/clients` shows the existing clients.
3. Check: `select * from public.memberships;` and the Supabase security advisor (no `rls_disabled`,
   `function_search_path_mutable` for the fixed functions).
