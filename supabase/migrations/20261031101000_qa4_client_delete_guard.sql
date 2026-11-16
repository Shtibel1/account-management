-- QA round 4 #1: deleting a client could wipe its books.
--
-- Any office member could DELETE /rest/v1/clients (policy clients_member_delete), and the
-- ON DELETE CASCADE foreign keys then removed every invoice of the client in any status (approved /
-- exported included) with its invoice_status_events audit trail, processing_jobs, invoice_exports
-- and corrections - bypassing the app's rule that only failed invoices are deleted
-- (DELETE /api/invoices/[id]); the cascade runs as the table owner, so invoices_status_guard did not
-- stop it. The files under raw-invoices/<client_id>/ were left behind (storage.protect_delete blocks
-- SQL deletes of storage objects).
--
-- Now:
-- 1. Browser sessions can't delete clients at all (no delete policy; clients_member_delete is
--    dropped). The only way is DELETE /api/clients/[id] (office owners), which also removes the
--    stored files through the Storage API - a direct REST delete would orphan them.
-- 2. delete_client_guarded() (service role, used by that route): deletes a client only while it has
--    nothing that must be kept: every invoice is 'error' or 'review', none was ever exported (no
--    exported_at, no invoice_exports rows), none has status audit events and no bank statement was
--    imported for it (bank_transactions and their matches). Atomic: client + invoices locked.
--    Rejecting / archiving is the way to stop working with such a client.
-- 3. clients_delete_guard (BEFORE DELETE): the same rule for browser sessions, as defence in depth
--    should a delete policy ever be added again ('client_delete_blocked: <reason>', P0001).
--    Configuration rows (account_mappings, supplier_automation, contacts, integrations, flags) are
--    deleted with the client on purpose: they only describe how to handle its invoices.
-- 4. invoice_status_events no longer cascade: invoice_id becomes nullable / ON DELETE SET NULL and the
--    row keeps client_id, so audit history outlives a deleted invoice or client.
-- The service role (ops scripts, the QA harness cleanup) is not blocked by the trigger and may still
-- delete any client directly (files under raw-invoices/<client_id>/ must then be removed through the
-- Storage API too); the audit events survive with invoice_id = null.
-- Idempotent: safe to run more than once.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Audit events survive the deletion of their invoice / client
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.invoice_status_events add column if not exists client_id uuid;

update public.invoice_status_events e
set client_id = i.client_id
from public.invoices i
where i.id = e.invoice_id and e.client_id is null;

create index if not exists invoice_status_events_client_idx
  on public.invoice_status_events (client_id, created_at desc);

alter table public.invoice_status_events alter column invoice_id drop not null;

do $$
declare
  v_name text;
begin
  for v_name in
    select con.conname
    from pg_constraint con
    where con.conrelid = 'public.invoice_status_events'::regclass
      and con.contype = 'f'
      and con.confrelid = 'public.invoices'::regclass
  loop
    execute format('alter table public.invoice_status_events drop constraint %I', v_name);
  end loop;
end;
$$;

alter table public.invoice_status_events
  add constraint invoice_status_events_invoice_id_fkey
  foreign key (invoice_id) references public.invoices(id) on delete set null;

-- client_id of new events from their invoice (reopen_invoice() and the reject route insert without it)
create or replace function public.invoice_status_events_fill_client()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.client_id is null and new.invoice_id is not null then
    select i.client_id into new.client_id from public.invoices i where i.id = new.invoice_id;
  end if;
  return new;
end;
$$;

revoke execute on function public.invoice_status_events_fill_client() from public, anon, authenticated;

drop trigger if exists invoice_status_events_fill_client on public.invoice_status_events;
create trigger invoice_status_events_fill_client
  before insert on public.invoice_status_events
  for each row execute function public.invoice_status_events_fill_client();

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. What keeps a client from being deleted
-- ─────────────────────────────────────────────────────────────────────────────
-- null = deletable; else 'not_found' | 'not_owner' | 'active_invoices' | 'exported' | 'audit_history'
-- | 'bank_transactions'. Execute stays granted to authenticated because the (invoker) guard trigger
-- calls it; a signed-in caller who isn't a member of the client's office gets 'not_found' (the same
-- answer as a missing id, so client ids of other offices can't be probed), a member who isn't an
-- owner gets 'not_owner'. The service role (no auth.uid()) gets the plain answer.
create or replace function public.client_delete_blocker(p_client_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid;
begin
  select c.org_id into v_org from public.clients c where c.id = p_client_id;
  if not found then
    return 'not_found';
  end if;
  if (select auth.uid()) is not null then
    if not public.is_org_member(v_org) then
      return 'not_found';
    end if;
    if not public.is_org_owner(v_org) then
      return 'not_owner';
    end if;
  end if;
  if exists (
    select 1 from public.invoices i
    where i.client_id = p_client_id and i.status::text not in ('error', 'review')
  ) then
    return 'active_invoices';
  end if;
  if exists (select 1 from public.invoices i where i.client_id = p_client_id and i.exported_at is not null)
     or exists (select 1 from public.invoice_exports x where x.client_id = p_client_id) then
    return 'exported';
  end if;
  if exists (select 1 from public.invoice_status_events e where e.client_id = p_client_id)
     or exists (
       select 1 from public.invoice_status_events e
       join public.invoices i on i.id = e.invoice_id
       where i.client_id = p_client_id
     ) then
    return 'audit_history';
  end if;
  if exists (select 1 from public.bank_transactions b where b.client_id = p_client_id) then
    return 'bank_transactions';
  end if;
  return null;
end;
$$;

revoke execute on function public.client_delete_blocker(uuid) from public, anon;
grant execute on function public.client_delete_blocker(uuid) to authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Guard trigger: browser sessions may delete only clients without anything to keep (defence in
--    depth: there is no delete policy for them, see 4)
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.clients_delete_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_blocker text;
begin
  if current_user in ('authenticated', 'anon') then
    v_blocker := public.client_delete_blocker(old.id);
    if v_blocker is not null then
      raise exception 'client_delete_blocked: % (client %)', v_blocker, old.id
        using errcode = 'P0001',
              hint = 'Only clients whose invoices are all failed or awaiting review, never exported and without audit history can be deleted.';
    end if;
  end if;
  return old;
end;
$$;

revoke execute on function public.clients_delete_guard() from public, anon, authenticated;

drop trigger if exists clients_delete_guard on public.clients;
create trigger clients_delete_guard
  before delete on public.clients
  for each row execute function public.clients_delete_guard();

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. No delete policy for browser sessions (was: any member). Deleting goes through
--    DELETE /api/clients/[id], which also removes the client's stored files.
-- ─────────────────────────────────────────────────────────────────────────────
drop policy if exists clients_member_delete on public.clients;
drop policy if exists clients_owner_delete on public.clients;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. delete_client_guarded(): check + delete in one transaction, for DELETE /api/clients/[id]
-- ─────────────────────────────────────────────────────────────────────────────
-- Returns 'deleted', or the blocker (see client_delete_blocker). The route checked that the caller
-- owns the office. The client row and its invoices are locked first, so an invoice approved or
-- exported meanwhile can't be deleted with the client. Service role only.
create or replace function public.delete_client_guarded(p_client_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_blocker text;
begin
  perform 1 from public.clients c where c.id = p_client_id for update;
  if not found then
    return 'not_found';
  end if;
  perform 1 from public.invoices i where i.client_id = p_client_id for update;
  v_blocker := public.client_delete_blocker(p_client_id);
  if v_blocker is not null then
    return v_blocker;
  end if;
  delete from public.clients c where c.id = p_client_id;
  return 'deleted';
end;
$$;

revoke execute on function public.delete_client_guarded(uuid) from public, anon, authenticated;
grant execute on function public.delete_client_guarded(uuid) to service_role;
