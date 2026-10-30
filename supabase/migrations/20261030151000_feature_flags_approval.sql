-- Feature flags per office + accountant review loop ("החזר ללקוח"). See docs/feature_flags.md.
--
-- 1. org_feature_flags: an office's own on/off value per flag (absent row = env default
--    FEATURE_FLAGS_DEFAULT, else off). Members read, owners write.
-- 2. invoices: status 'returned' + return_reason_code / return_reason / returned_at / returned_by,
--    and the link between a returned invoice and the corrected document the client re-sent.
-- 3. clients.contact_email: where "returned" notifications are emailed.
-- 4. client_notifications: log of every notification attempt (sent / failed / not_sent).
--    Written only by the server (service role); members of the office can read it.
-- RLS follows 20261030140000_auth_tenancy.sql: authenticated only, scoped by org membership,
-- WITH CHECK on writes, nothing for anon.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Feature flags
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.org_feature_flags (
  org_id uuid not null references public.organizations(id) on delete cascade,
  flag text not null check (flag ~ '^[a-z][a-z0-9_]{1,62}$'),
  enabled boolean not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null,
  primary key (org_id, flag)
);

alter table public.org_feature_flags enable row level security;

revoke all on public.org_feature_flags from anon;
grant select, insert, update, delete on public.org_feature_flags to authenticated;

drop policy if exists org_feature_flags_member_select on public.org_feature_flags;
create policy org_feature_flags_member_select on public.org_feature_flags
  for select to authenticated
  using (public.is_org_member(org_id));

drop policy if exists org_feature_flags_owner_insert on public.org_feature_flags;
create policy org_feature_flags_owner_insert on public.org_feature_flags
  for insert to authenticated
  with check (public.is_org_owner(org_id));

drop policy if exists org_feature_flags_owner_update on public.org_feature_flags;
create policy org_feature_flags_owner_update on public.org_feature_flags
  for update to authenticated
  using (public.is_org_owner(org_id))
  with check (public.is_org_owner(org_id));

drop policy if exists org_feature_flags_owner_delete on public.org_feature_flags;
create policy org_feature_flags_owner_delete on public.org_feature_flags
  for delete to authenticated
  using (public.is_org_owner(org_id));

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. invoices: 'returned' status + return details + resubmission link
-- ─────────────────────────────────────────────────────────────────────────────

-- The original invoices table was created outside these migrations, so the status column may be a
-- plain text, a text with a CHECK constraint, or an enum. Handle all three.
do $$
declare
  v_type regtype;
  v_enum_type text;
  r record;
begin
  select a.atttypid::regtype into v_type
  from pg_attribute a
  where a.attrelid = 'public.invoices'::regclass and a.attname = 'status' and not a.attisdropped;

  select t.typname into v_enum_type
  from pg_attribute a
  join pg_type t on t.oid = a.atttypid
  where a.attrelid = 'public.invoices'::regclass and a.attname = 'status' and t.typtype = 'e';

  if v_enum_type is not null then
    execute format('alter type %s add value if not exists %L', v_type, 'returned');
  else
    -- Replace any CHECK constraint on status with one that also allows 'returned'.
    for r in
      select c.conname
      from pg_constraint c
      where c.conrelid = 'public.invoices'::regclass
        and c.contype = 'c'
        and pg_get_constraintdef(c.oid) ilike '%status%'
    loop
      execute format('alter table public.invoices drop constraint %I', r.conname);
    end loop;

    alter table public.invoices
      add constraint invoices_status_check
      check (status in ('processing', 'review', 'approved', 'exported', 'error', 'rejected', 'returned'))
      not valid;
  end if;
end;
$$;

alter table public.invoices
  add column if not exists return_reason_code text
    check (return_reason_code is null or return_reason_code in
      ('unreadable', 'missing_allocation', 'not_tax_invoice', 'private_expense', 'other')),
  add column if not exists return_reason text check (return_reason is null or length(return_reason) <= 600),
  add column if not exists returned_at timestamptz,
  add column if not exists returned_by uuid references auth.users(id) on delete set null,
  -- On the returned invoice: the corrected document the client sent afterwards.
  add column if not exists resubmitted_invoice_id uuid references public.invoices(id) on delete set null,
  -- On the corrected document: the returned invoice it replaces.
  add column if not exists resubmission_of uuid references public.invoices(id) on delete set null;

create index if not exists invoices_returned_idx
  on public.invoices (client_id, returned_at desc)
  where status = 'returned';

-- Both resubmission links must point at an invoice of the same client (the invoices RLS policy
-- only checks client_id of the row itself, so enforce this for every writer).
create or replace function public.invoices_resubmission_same_client()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.resubmitted_invoice_id is not null and not exists (
    select 1 from public.invoices i where i.id = new.resubmitted_invoice_id and i.client_id = new.client_id
  ) then
    raise exception 'resubmitted_invoice_id must reference an invoice of the same client';
  end if;
  if new.resubmission_of is not null and not exists (
    select 1 from public.invoices i where i.id = new.resubmission_of and i.client_id = new.client_id
  ) then
    raise exception 'resubmission_of must reference an invoice of the same client';
  end if;
  return new;
end;
$$;

revoke execute on function public.invoices_resubmission_same_client() from public, anon, authenticated;

drop trigger if exists invoices_resubmission_same_client on public.invoices;
create trigger invoices_resubmission_same_client
  before insert or update of resubmitted_invoice_id, resubmission_of, client_id on public.invoices
  for each row
  when (new.resubmitted_invoice_id is not null or new.resubmission_of is not null)
  execute function public.invoices_resubmission_same_client();

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. clients.contact_email
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.clients
  add column if not exists contact_email text
    check (contact_email is null or (contact_email = lower(btrim(contact_email)) and contact_email ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' and length(contact_email) <= 254));

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. client_notifications (send log)
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.client_notifications (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  invoice_id uuid references public.invoices(id) on delete set null,
  kind text not null default 'invoice_returned' check (kind in ('invoice_returned')),
  channel text not null check (channel in ('email', 'whatsapp')),
  -- "to" is a reserved word in SQL; the recipient address / E.164 phone (null = none on file).
  recipient text,
  status text not null check (status in ('sent', 'failed', 'not_sent')),
  error text,
  provider_message_id text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists client_notifications_invoice_idx on public.client_notifications (invoice_id, created_at desc);
create index if not exists client_notifications_client_idx on public.client_notifications (client_id, created_at desc);

-- org_id must be the client's office (the server always sets both; keep the log consistent).
create or replace function public.client_notifications_check_org()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.clients c where c.id = new.client_id and c.org_id = new.org_id) then
    raise exception 'client_notifications.org_id must be the office of client_id';
  end if;
  if new.invoice_id is not null and not exists (
    select 1 from public.invoices i where i.id = new.invoice_id and i.client_id = new.client_id
  ) then
    raise exception 'client_notifications.invoice_id must belong to client_id';
  end if;
  return new;
end;
$$;

revoke execute on function public.client_notifications_check_org() from public, anon, authenticated;

drop trigger if exists client_notifications_check_org on public.client_notifications;
create trigger client_notifications_check_org
  before insert or update on public.client_notifications
  for each row execute function public.client_notifications_check_org();

alter table public.client_notifications enable row level security;

revoke all on public.client_notifications from anon;
-- Audit log: read-only for office members; rows are written by the server (service role) only.
grant select on public.client_notifications to authenticated;

drop policy if exists client_notifications_member_select on public.client_notifications;
create policy client_notifications_member_select on public.client_notifications
  for select to authenticated
  using (
    public.is_org_member(org_id)
    and client_id in (select public.accessible_client_ids())
  );
