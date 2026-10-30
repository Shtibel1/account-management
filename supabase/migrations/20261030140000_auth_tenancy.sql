-- Login + per-office (organization) tenancy. See docs/auth.md.
--
-- Model: an organization = one bookkeeping office. Users belong to organizations through
-- memberships (role owner | member). Every client belongs to exactly one organization
-- (clients.org_id); every other tenant table is keyed by client_id and inherits access through it.
--
-- Before this migration every table had an "allow all to anon" policy and the browser used the anon
-- key directly. After it:
--   * anon gets nothing (no policies, table/function privileges revoked);
--   * authenticated users see/modify only rows of clients in organizations they are members of;
--   * service_role (server-side API routes after their own access check, the LangGraph pipeline,
--     the email/WhatsApp webhooks) bypasses RLS as before.
--
-- Deploy prerequisite: SUPABASE_SERVICE_KEY must be set for the server (Amplify env). Without it the
-- server falls back to the anon key, which no longer has any access.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Organizations, memberships, invitations
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) > 0),
  created_at timestamptz not null default now()
);

create table if not exists public.memberships (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'member')),
  created_at timestamptz not null default now(),
  constraint memberships_org_user_key unique (org_id, user_id)
);

create index if not exists memberships_user_idx on public.memberships (user_id);

-- Pending "add member by email" for people without an account yet. Written only by the server
-- (POST /api/org/members, owner-only); claimed when that email is confirmed (trigger below).
create table if not exists public.org_invitations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  email text not null check (email = lower(btrim(email)) and position('@' in email) > 1),
  role text not null default 'member' check (role in ('owner', 'member')),
  invited_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint org_invitations_org_email_key unique (org_id, email)
);

create index if not exists org_invitations_email_idx on public.org_invitations (email);

-- The existing office. Fixed id so the bootstrap-owner logic below can refer to it.
insert into public.organizations (id, name)
values ('00000000-0000-4000-8000-000000000001', 'המשרד של נדב')
on conflict (id) do nothing;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. clients.org_id (+ backfill: every existing client belongs to the existing office)
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.clients
  add column if not exists org_id uuid references public.organizations(id) on delete restrict;

update public.clients
  set org_id = '00000000-0000-4000-8000-000000000001'
  where org_id is null;

alter table public.clients alter column org_id set not null;

create index if not exists clients_org_idx on public.clients (org_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Access helpers (security definer: they read memberships regardless of the caller's RLS)
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.is_org_member(org uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.memberships m
    where m.org_id = org and m.user_id = (select auth.uid())
  )
$$;

create or replace function public.is_org_owner(org uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.memberships m
    where m.org_id = org and m.user_id = (select auth.uid()) and m.role = 'owner'
  )
$$;

-- Ids of every client the current user may access (used as `client_id in (select ...)` so it is
-- evaluated once per statement, not once per row).
create or replace function public.accessible_client_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select c.id
  from public.clients c
  join public.memberships m on m.org_id = c.org_id
  where m.user_id = (select auth.uid())
$$;

-- Storage object names in raw-invoices are "<client_id>/<file>".
create or replace function public.can_access_storage_object(object_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when split_part(coalesce(object_name, ''), '/', 1)
         ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then exists (
      select 1
      from public.clients c
      join public.memberships m on m.org_id = c.org_id
      where c.id = split_part(object_name, '/', 1)::uuid
        and m.user_id = (select auth.uid())
    )
    else false
  end
$$;

revoke execute on function public.is_org_member(uuid) from public, anon;
revoke execute on function public.is_org_owner(uuid) from public, anon;
revoke execute on function public.accessible_client_ids() from public, anon;
revoke execute on function public.can_access_storage_object(text) from public, anon;
grant execute on function public.is_org_member(uuid) to authenticated, service_role;
grant execute on function public.is_org_owner(uuid) to authenticated, service_role;
grant execute on function public.accessible_client_ids() to authenticated, service_role;
grant execute on function public.can_access_storage_object(text) to authenticated, service_role;

-- New clients created from the browser without an explicit org_id go to the creator's first
-- organization (RLS still checks membership of whatever org_id ends up on the row).
create or replace function public.clients_default_org()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.org_id is null then
    select m.org_id into new.org_id
    from public.memberships m
    where m.user_id = (select auth.uid())
    order by m.created_at, m.org_id
    limit 1;
  end if;
  return new;
end;
$$;

revoke execute on function public.clients_default_org() from public, anon;

drop trigger if exists clients_default_org on public.clients;
create trigger clients_default_org
  before insert on public.clients
  for each row execute function public.clients_default_org();

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Provisioning on signup / email confirmation
-- ─────────────────────────────────────────────────────────────────────────────
-- Runs once a user's email is confirmed (immediately on insert when the project auto-confirms;
-- otherwise when they click the confirmation / invite link). Waiting for confirmation means
-- nobody can claim the bootstrap owner or someone else's invitation by signing up with an email
-- they don't control.
--   * nadavshtibel@gmail.com -> owner of the existing office ("המשרד של נדב");
--   * pending org_invitations for the email -> memberships (invitations consumed);
--   * anyone still without a membership -> a new organization, as its owner.

create or replace function public.provision_user_memberships(p_user_id uuid, p_email text, p_meta jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_org uuid;
  v_name text;
begin
  if v_email = 'nadavshtibel@gmail.com' then
    insert into public.memberships (org_id, user_id, role)
    values ('00000000-0000-4000-8000-000000000001', p_user_id, 'owner')
    on conflict (org_id, user_id) do update set role = 'owner';
  end if;

  if v_email <> '' then
    insert into public.memberships (org_id, user_id, role)
    select i.org_id, p_user_id, i.role
    from public.org_invitations i
    where i.email = v_email
    on conflict (org_id, user_id) do nothing;

    delete from public.org_invitations i where i.email = v_email;
  end if;

  if not exists (select 1 from public.memberships m where m.user_id = p_user_id) then
    v_name := nullif(btrim(coalesce(p_meta->>'org_name', '')), '');
    if v_name is null then
      v_name := nullif(btrim(coalesce(p_meta->>'full_name', '')), '');
      if v_name is not null then
        v_name := 'המשרד של ' || v_name;
      end if;
    end if;
    if v_name is null then
      v_name := 'המשרד של ' || coalesce(nullif(split_part(v_email, '@', 1), ''), 'משתמש חדש');
    end if;

    insert into public.organizations (name) values (left(v_name, 200)) returning id into v_org;
    insert into public.memberships (org_id, user_id, role) values (v_org, p_user_id, 'owner');
  end if;
end;
$$;

revoke execute on function public.provision_user_memberships(uuid, text, jsonb) from public, anon, authenticated;

create or replace function public.handle_auth_user_provisioning()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.email_confirmed_at is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.email_confirmed_at is not null then
    return new; -- already provisioned (e.g. later email change): nothing to do
  end if;

  begin
    perform public.provision_user_memberships(new.id, new.email, coalesce(new.raw_user_meta_data, '{}'::jsonb));
  exception when others then
    -- Never block sign-up / sign-in; the user just has no organization yet (the app shows that).
    raise warning 'provision_user_memberships failed for user %: %', new.id, sqlerrm;
  end;
  return new;
end;
$$;

revoke execute on function public.handle_auth_user_provisioning() from public, anon, authenticated;

drop trigger if exists on_auth_user_provisioning on auth.users;
create trigger on_auth_user_provisioning
  after insert or update of email_confirmed_at on auth.users
  for each row execute function public.handle_auth_user_provisioning();

-- Users that already exist (incl. nadavshtibel@gmail.com if it was created before this migration).
do $$
declare
  u record;
begin
  for u in
    select id, email, raw_user_meta_data
    from auth.users
    where email_confirmed_at is not null
    order by created_at
  loop
    perform public.provision_user_memberships(u.id, u.email, coalesce(u.raw_user_meta_data, '{}'::jsonb));
  end loop;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Row level security
-- ─────────────────────────────────────────────────────────────────────────────

-- 5a. Drop every existing policy in public (the "allow all to anon" ones from the original schema
-- and from 20261030000000..20261030136000) and make sure RLS is on for every public table, so a
-- table without a policy below is service-role only.
do $$
declare
  r record;
begin
  for r in select schemaname, tablename, policyname from pg_policies where schemaname = 'public' loop
    execute format('drop policy if exists %I on %I.%I', r.policyname, r.schemaname, r.tablename);
  end loop;

  for r in
    select n.nspname, c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p')
  loop
    execute format('alter table %I.%I enable row level security', r.nspname, r.relname);
  end loop;
end;
$$;

-- 5b. anon: nothing. authenticated: table privileges (RLS below decides which rows).
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke execute on all functions in schema public from anon;
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on sequences from anon;
alter default privileges in schema public revoke execute on functions from anon;

grant select on public.organizations, public.memberships, public.org_invitations to authenticated;
grant select, insert, update, delete on
  public.clients,
  public.invoices,
  public.account_mappings,
  public.invoice_corrections,
  public.supplier_automation,
  public.duplicate_dismissals,
  public.client_contacts,
  public.bank_transactions
to authenticated;

-- 5c. Organizations / memberships / invitations: read-only for members; writes go through the
-- server (service role) or the provisioning trigger.
create policy organizations_member_select on public.organizations
  for select to authenticated
  using (public.is_org_member(id));

create policy memberships_member_select on public.memberships
  for select to authenticated
  using (user_id = (select auth.uid()) or public.is_org_member(org_id));

create policy org_invitations_owner_select on public.org_invitations
  for select to authenticated
  using (public.is_org_owner(org_id));

-- 5d. Clients: scoped by org membership.
create policy clients_member_select on public.clients
  for select to authenticated
  using (public.is_org_member(org_id));

create policy clients_member_insert on public.clients
  for insert to authenticated
  with check (public.is_org_member(org_id));

create policy clients_member_update on public.clients
  for update to authenticated
  using (public.is_org_member(org_id))
  with check (public.is_org_member(org_id));

create policy clients_member_delete on public.clients
  for delete to authenticated
  using (public.is_org_member(org_id));

-- 5e. Tables keyed by client_id: through clients.org_id.
create policy invoices_member_all on public.invoices
  for all to authenticated
  using (client_id in (select public.accessible_client_ids()))
  with check (client_id in (select public.accessible_client_ids()));

create policy account_mappings_member_all on public.account_mappings
  for all to authenticated
  using (client_id in (select public.accessible_client_ids()))
  with check (client_id in (select public.accessible_client_ids()));

create policy supplier_automation_member_all on public.supplier_automation
  for all to authenticated
  using (client_id in (select public.accessible_client_ids()))
  with check (
    client_id in (select public.accessible_client_ids())
    and (
      disabled_by_invoice_id is null
      or exists (select 1 from public.invoices i where i.id = disabled_by_invoice_id and i.client_id = supplier_automation.client_id)
    )
  );

create policy client_contacts_member_all on public.client_contacts
  for all to authenticated
  using (client_id in (select public.accessible_client_ids()))
  with check (client_id in (select public.accessible_client_ids()));

create policy duplicate_dismissals_member_all on public.duplicate_dismissals
  for all to authenticated
  using (client_id in (select public.accessible_client_ids()))
  with check (
    client_id in (select public.accessible_client_ids())
    and exists (select 1 from public.invoices i where i.id = invoice_id and i.client_id = duplicate_dismissals.client_id)
    and exists (select 1 from public.invoices i where i.id = other_invoice_id and i.client_id = duplicate_dismissals.client_id)
  );

create policy bank_transactions_member_all on public.bank_transactions
  for all to authenticated
  using (client_id in (select public.accessible_client_ids()))
  with check (
    client_id in (select public.accessible_client_ids())
    and (
      matched_invoice_id is null
      or exists (select 1 from public.invoices i where i.id = matched_invoice_id and i.client_id = bank_transactions.client_id)
    )
  );

-- invoice_corrections.client_id is nullable (on delete set null): scope through the invoice.
create policy invoice_corrections_member_all on public.invoice_corrections
  for all to authenticated
  using (exists (
    select 1 from public.invoices i
    where i.id = invoice_id and i.client_id in (select public.accessible_client_ids())
  ))
  with check (exists (
    -- client_id (read by the supplier-automation eligibility check) must be the invoice's own
    -- client, so a member can't write correction rows attributed to another office's client.
    select 1 from public.invoices i
    where i.id = invoice_id
      and i.client_id in (select public.accessible_client_ids())
      and (invoice_corrections.client_id is null or invoice_corrections.client_id = i.client_id)
  ));

-- 5f. Views stay security_invoker (they inherit the policies above); no anon access.
alter view public.field_accuracy set (security_invoker = true);
alter view public.supplier_accuracy set (security_invoker = true);
alter view public.fewshot_accuracy set (security_invoker = true);
revoke all on public.field_accuracy, public.supplier_accuracy, public.fewshot_accuracy from anon;
grant select on public.field_accuracy, public.supplier_accuracy, public.fewshot_accuracy to authenticated, service_role;

-- 5g. RPCs used by the app (security invoker -> RLS applies to authenticated callers).
revoke execute on function public.find_duplicate_candidates(uuid, uuid, text, text, text, text) from public, anon;
revoke execute on function public.normalize_invoice_number(text) from public, anon;
grant execute on function public.find_duplicate_candidates(uuid, uuid, text, text, text, text) to authenticated, service_role;
grant execute on function public.normalize_invoice_number(text) to authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Storage: raw-invoices (objects at "<client_id>/<file>")
-- ─────────────────────────────────────────────────────────────────────────────
-- The app reads/writes the bucket only server-side (service role: signed upload URLs, signed read
-- URLs, pipeline uploads), so these policies are defense in depth for direct authenticated access.
-- Signed URLs keep working on a private bucket.

update storage.buckets set public = false where id = 'raw-invoices';

do $$
declare
  r record;
begin
  for r in
    select policyname
    from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and (
        coalesce(qual, '') ilike '%raw-invoices%'
        or coalesce(with_check, '') ilike '%raw-invoices%'
        or (
          (roles && array['anon', 'public']::name[])
          and regexp_replace(coalesce(qual, with_check, 'true'), '[()\s]', '', 'g') = 'true'
        )
      )
  loop
    begin
      execute format('drop policy if exists %I on storage.objects', r.policyname);
    exception when others then
      raise warning 'Could not drop storage policy %: %', r.policyname, sqlerrm;
    end;
  end loop;
end;
$$;

drop policy if exists raw_invoices_member_select on storage.objects;
create policy raw_invoices_member_select on storage.objects
  for select to authenticated
  using (bucket_id = 'raw-invoices' and public.can_access_storage_object(name));

drop policy if exists raw_invoices_member_insert on storage.objects;
create policy raw_invoices_member_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'raw-invoices' and public.can_access_storage_object(name));

drop policy if exists raw_invoices_member_update on storage.objects;
create policy raw_invoices_member_update on storage.objects
  for update to authenticated
  using (bucket_id = 'raw-invoices' and public.can_access_storage_object(name))
  with check (bucket_id = 'raw-invoices' and public.can_access_storage_object(name));

drop policy if exists raw_invoices_member_delete on storage.objects;
create policy raw_invoices_member_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'raw-invoices' and public.can_access_storage_object(name));

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. Fixed search_path on existing functions (Supabase linter: function_search_path_mutable)
-- ─────────────────────────────────────────────────────────────────────────────
-- Bodies only use pg_catalog functions (always searched), so '' keeps their behavior.
alter function public.normalize_invoice_number(text) set search_path = '';
alter function public.bank_transactions_before_update() set search_path = '';

-- update_updated_at was created outside the migrations; its body isn't in this repo, so pin it to
-- public (same resolution as before for the usual `new.updated_at = now()` body).
do $$
begin
  if to_regprocedure('public.update_updated_at()') is not null then
    alter function public.update_updated_at() set search_path = public;
  else
    raise notice 'public.update_updated_at() not found - skipped';
  end if;
end;
$$;
