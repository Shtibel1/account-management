-- QA round 8: a client that can't be deleted (its invoices have audit history, were exported, or
-- it has bank lines - see delete_client_guarded) can be archived instead: hidden from the clients
-- page, the pickers (bank, mappings, integrations, move-invoice), restorable from the clients page.
-- PATCH /api/clients/[id] { archived } sets it (office owners only). Archiving keeps every row.
--
-- Archived clients don't take part in the unique-name rule (20261031130000_qa8_unique_client_name):
-- a new client may reuse an archived client's name, and restoring a client whose name is now used
-- by an active one is refused (23505) until it is renamed.

alter table public.clients add column if not exists archived_at timestamptz;

create or replace function public.clients_unique_name()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key text := public.client_name_key(new.name);
begin
  -- Archived rows never conflict.
  if new.archived_at is not null then
    return new;
  end if;
  -- An active row that keeps its name and office (e.g. an existing duplicate getting its VAT code).
  if tg_op = 'UPDATE'
     and old.archived_at is null
     and v_key = public.client_name_key(old.name)
     and new.org_id is not distinct from old.org_id then
    return new;
  end if;
  if v_key = '' then
    return new;
  end if;

  -- Serializes concurrent creates / renames / restores of the same name in the same office.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(coalesce(new.org_id::text, '') || '|' || v_key, 0));

  if exists (
    select 1 from public.clients c
    where c.org_id is not distinct from new.org_id
      and c.id <> new.id
      and c.archived_at is null
      and public.client_name_key(c.name) = v_key
  ) then
    raise exception 'clients.name already exists in this office'
      using errcode = '23505', hint = 'לקוח בשם זה כבר קיים במשרד';
  end if;
  return new;
end;
$$;

revoke all on function public.clients_unique_name() from public, anon, authenticated;

drop trigger if exists clients_unique_name on public.clients;
create trigger clients_unique_name
  before insert or update of name, org_id, archived_at on public.clients
  for each row execute function public.clients_unique_name();

-- Archiving is for office owners: only the server (PATCH /api/clients/[id], after its owner check)
-- sets archived_at; members' direct PostgREST writes of it are refused.
create or replace function public.clients_archive_server_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('authenticated', 'anon')
     and ((tg_op = 'INSERT' and new.archived_at is not null)
          or (tg_op = 'UPDATE' and new.archived_at is distinct from old.archived_at)) then
    raise exception 'clients.archived_at can only be changed through the application'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.clients_archive_server_only() from public, anon, authenticated;

drop trigger if exists clients_archive_server_only on public.clients;
create trigger clients_archive_server_only
  before insert or update of archived_at on public.clients
  for each row execute function public.clients_archive_server_only();
