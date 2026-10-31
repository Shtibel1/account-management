-- QA round 8: two clients with the same name in one office (two "QA-דפדפן" cards that the review
-- filter could only tell apart by their VAT code). The app creates and renames clients through
-- POST /api/clients and PATCH /api/clients/[id] (src/lib/clientRecords.ts), which answer 409 with a
-- Hebrew message; this trigger also stops writes that bypass the API (members can still write
-- `clients` through PostgREST under RLS) and two simultaneous creates.
--
-- Not a unique index: the live DB already holds duplicate names (QA offices, and an old QA run in a
-- real office), which an index would reject. The trigger checks only a new row or a changed name /
-- office, so existing duplicates stay editable (e.g. their VAT code).
--
-- Names are compared like normalizeClientName() in src/shared/clientName.ts: NFC, inner whitespace
-- collapsed, trimmed, lower-cased.

create or replace function public.client_name_key(p_name text)
returns text
language sql
immutable
set search_path = ''
as $$
  select lower(btrim(regexp_replace(normalize(coalesce(p_name, ''), NFC), '\s+', ' ', 'g')))
$$;

create or replace function public.clients_unique_name()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key text := public.client_name_key(new.name);
begin
  if tg_op = 'UPDATE'
     and v_key = public.client_name_key(old.name)
     and new.org_id is not distinct from old.org_id then
    return new;
  end if;
  if v_key = '' then
    return new;
  end if;

  -- Serializes concurrent creates / renames of the same name in the same office.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(coalesce(new.org_id::text, '') || '|' || v_key, 0));

  if exists (
    select 1 from public.clients c
    where c.org_id is not distinct from new.org_id
      and c.id <> new.id
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
  before insert or update of name, org_id on public.clients
  for each row execute function public.clients_unique_name();
