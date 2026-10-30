-- QA status integrity (findings #3, #5, #9, #10, #19, #24).
--
-- 1. invoices_status_check allows every status the app uses. The live constraint predates
--    'rejected' (the reject button always failed with 23514) and 'returned'. The original table
--    was created outside these migrations, so handle text + CHECK, plain text and enum columns.
-- 2. invoices_status_guard trigger:
--    a) an exported invoice is final: its status only changes through reopen_invoice() below
--       (owner-only in the API, logged) - re-approving it no longer lets it be exported twice;
--    b) signed-in browser sessions (role authenticated/anon, i.e. PostgREST with the user's JWT)
--       may not change status / reviewed_at / exported_at / validated_data / ai_confidence directly,
--       may only insert invoices in 'processing', and may not delete invoices (the app never does
--       any of these from the browser; otherwise the RLS policy would let a user insert an
--       'approved' row with unchecked data and export it).
--       Those go through the API routes (approve / reject / retry / reopen / export), which validate
--       the data and the transition (src/shared/invoiceStatus.ts) and use the service role.
-- 3. invoice_status_events: audit log of reopen actions (and other explicit status actions).
-- 4. reopen_invoice(): the only way back to 'review' from approved / rejected / returned / exported.
--
-- Status set, from the code (src/shared/types.ts InvoiceStatus, src/shared/invoiceStatus.ts):
--   processing, review, approved, exported, error, rejected, returned

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Status check constraint
-- ─────────────────────────────────────────────────────────────────────────────
do $$
declare
  v_attnum smallint;
  v_type regtype;
  v_is_enum boolean;
  v_status text;
  r record;
begin
  select a.attnum, a.atttypid::regtype, (t.typtype = 'e')
    into v_attnum, v_type, v_is_enum
  from pg_attribute a
  join pg_type t on t.oid = a.atttypid
  where a.attrelid = 'public.invoices'::regclass and a.attname = 'status' and not a.attisdropped;

  if v_attnum is null then
    raise exception 'public.invoices.status not found';
  end if;

  if v_is_enum then
    foreach v_status in array array['processing', 'review', 'approved', 'exported', 'error', 'rejected', 'returned'] loop
      execute format('alter type %s add value if not exists %L', v_type, v_status);
    end loop;
  else
    -- Drop every CHECK constraint on the status column alone (whatever its name), plus the
    -- well-known name in case it was defined differently.
    for r in
      select c.conname
      from pg_constraint c
      where c.conrelid = 'public.invoices'::regclass
        and c.contype = 'c'
        and c.conkey = array[v_attnum]
    loop
      execute format('alter table public.invoices drop constraint if exists %I', r.conname);
    end loop;
    alter table public.invoices drop constraint if exists invoices_status_check;

    alter table public.invoices
      add constraint invoices_status_check
      check (status in ('processing', 'review', 'approved', 'exported', 'error', 'rejected', 'returned'))
      not valid;
  end if;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Audit log of explicit status actions
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.invoice_status_events (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  from_status text not null,
  to_status text not null,
  action text not null check (action in ('reopen')),
  actor_id uuid references auth.users(id) on delete set null,
  reason text check (reason is null or length(reason) <= 500),
  -- exported_at at the time of a reopen (the export it may duplicate)
  exported_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists invoice_status_events_invoice_idx
  on public.invoice_status_events (invoice_id, created_at desc);

alter table public.invoice_status_events enable row level security;

drop policy if exists invoice_status_events_member_select on public.invoice_status_events;
create policy invoice_status_events_member_select on public.invoice_status_events
  for select to authenticated
  using (exists (
    select 1 from public.invoices i
    where i.id = invoice_status_events.invoice_id
      and i.client_id in (select public.accessible_client_ids())
  ));
-- Written only by reopen_invoice() (security definer) / the service role.
revoke insert, update, delete on public.invoice_status_events from anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Guard trigger
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.invoices_status_guard()
returns trigger
language plpgsql
as $$
declare
  v_browser boolean := current_user in ('authenticated', 'anon');
begin
  if tg_op = 'INSERT' then
    -- Uploads go through the API (service role). A browser session may only create a document
    -- waiting to be processed, never an already approved / exported / reviewed one.
    if v_browser
       and (new.status::text <> 'processing'
            or new.reviewed_at is not null
            or new.exported_at is not null) then
      raise exception 'invoice_status_api_only: new invoices start in processing'
        using errcode = 'P0001';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    -- Only failed documents are deleted, through DELETE /api/invoices/[id].
    if v_browser then
      raise exception 'invoice_status_api_only: invoice % is deleted through the API only', old.id
        using errcode = 'P0001';
    end if;
    return old;
  end if;

  -- UPDATE
  if new.status is distinct from old.status
     and old.status::text = 'exported'
     and coalesce(current_setting('app.invoice_reopen', true), '') <> 'on' then
    raise exception 'invoice_exported_final: invoice % is exported; reopen it explicitly', old.id
      using errcode = 'P0001';
  end if;

  if v_browser
     and (new.status is distinct from old.status
          or new.reviewed_at is distinct from old.reviewed_at
          or new.exported_at is distinct from old.exported_at
          or new.validated_data is distinct from old.validated_data
          or new.ai_confidence is distinct from old.ai_confidence) then
    raise exception 'invoice_status_api_only: invoice % status/approval fields change through the API only', old.id
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

drop trigger if exists invoices_status_guard on public.invoices;
create trigger invoices_status_guard
  before insert or update or delete on public.invoices
  for each row execute function public.invoices_status_guard();

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. reopen_invoice(): back to review, logged. Called by POST /api/invoices/[id]/reopen with the
--    service role after the route checked access (and office ownership for exported invoices).
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.reopen_invoice(p_invoice_id uuid, p_actor_id uuid, p_reason text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_exported_at timestamptz;
begin
  select status::text, exported_at into v_status, v_exported_at
  from public.invoices where id = p_invoice_id
  for update;

  if v_status is null then
    raise exception 'invoice_not_found' using errcode = 'P0002';
  end if;
  if v_status not in ('approved', 'rejected', 'returned', 'exported') then
    raise exception 'invoice_not_reopenable: status %', v_status using errcode = 'P0001';
  end if;

  perform set_config('app.invoice_reopen', 'on', true);
  update public.invoices
    set status = 'review', updated_at = now()
    where id = p_invoice_id;
  perform set_config('app.invoice_reopen', '', true);

  insert into public.invoice_status_events (invoice_id, from_status, to_status, action, actor_id, reason, exported_at)
  values (p_invoice_id, v_status, 'review', 'reopen', p_actor_id, nullif(left(coalesce(p_reason, ''), 500), ''), v_exported_at);

  return v_status;
end;
$$;

revoke all on function public.reopen_invoice(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.reopen_invoice(uuid, uuid, text) to service_role;
