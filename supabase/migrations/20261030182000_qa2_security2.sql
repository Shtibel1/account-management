-- QA round 2 fixes (security2 cluster): findings N6, N8, N17, N21 of the 2026-10-30 round-2 QA.
--
-- 1. N6  lead_rate_limit_hit_all(): all-or-nothing rate limit check of the public lead form. A
--        request refused by any bucket (e.g. the per-IP one) counts NOTHING, so one IP can no
--        longer use up the global hourly budget of every other visitor.
-- 2. N8  Large bank statements: chunks are staged in bank_import_staging (small, fast calls) and
--        commit_bank_import() moves the whole batch into bank_transactions in one statement (all
--        or nothing) with its own statement_timeout, instead of one huge RPC that hit the 8 s
--        authenticator statement timeout.
-- 3. N17 Format of bookkeeping codes enforced in the DB for NEW writes: account_mappings.account_code
--        (digits, up to 15), account_mappings.vat_id (9 digits + Israeli check digit),
--        clients.vat_account (digits, up to 15). Checked only on INSERT or when the column changes,
--        so legacy rows with free text don't break unrelated updates. Errors use SQLSTATE 23514
--        with the column name in the message (mappingDbErrorMessage maps them to Hebrew).
-- 4. N21 clients.contact_email (accountant_review_loop, flag-gated) can only be written by the
--        server (service role), i.e. through PUT /api/clients/[id]/contact-email which checks the
--        flag. Direct PostgREST writes by members are refused.
-- Idempotent: safe to run more than once.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Lead form rate limits: all or nothing
-- ─────────────────────────────────────────────────────────────────────────────
-- p_buckets: [{bucket, window_seconds, max}]. Returns true and counts one hit on every bucket when
-- each has room in its current window; otherwise returns false and counts nothing. Rows are locked
-- in a fixed order, so concurrent requests can't both pass on the last free slot.
create or replace function public.lead_rate_limit_hit_all(p_buckets jsonb)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  b record;
  v_hits integer;
begin
  if p_buckets is null or jsonb_typeof(p_buckets) <> 'array' or jsonb_array_length(p_buckets) = 0
     or jsonb_array_length(p_buckets) > 10 then
    return false;
  end if;

  -- Make sure every current-window row exists, then lock them (ordered: no deadlocks).
  for b in
    select x.bucket,
           to_timestamp(floor(extract(epoch from now()) / greatest(coalesce(x.window_seconds, 60), 1))
                        * greatest(coalesce(x.window_seconds, 60), 1)) as window_start,
           coalesce(x.max, 0) as max
    from jsonb_to_recordset(p_buckets) as x(bucket text, window_seconds integer, max integer)
    order by x.bucket
  loop
    if b.bucket is null or length(b.bucket) = 0 or length(b.bucket) > 128 then
      return false;
    end if;
    insert into public.lead_rate_limits (bucket, window_start, hits)
    values (b.bucket, b.window_start, 0)
    on conflict (bucket, window_start) do nothing;

    select l.hits into v_hits
    from public.lead_rate_limits l
    where l.bucket = b.bucket and l.window_start = b.window_start
    for update;

    if v_hits >= b.max then
      return false;   -- refused: nothing counted (the zero-hit rows inserted above are harmless)
    end if;
  end loop;

  update public.lead_rate_limits l
  set hits = l.hits + 1
  from (
    select x.bucket,
           to_timestamp(floor(extract(epoch from now()) / greatest(coalesce(x.window_seconds, 60), 1))
                        * greatest(coalesce(x.window_seconds, 60), 1)) as window_start
    from jsonb_to_recordset(p_buckets) as x(bucket text, window_seconds integer, max integer)
  ) w
  where l.bucket = w.bucket and l.window_start = w.window_start;

  -- Housekeeping: windows older than two days are never read again.
  if random() < 0.05 then
    delete from public.lead_rate_limits where window_start < now() - interval '2 days';
  end if;

  return true;
end;
$$;

revoke execute on function public.lead_rate_limit_hit_all(jsonb) from public, anon, authenticated;
grant execute on function public.lead_rate_limit_hit_all(jsonb) to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Bank import: staging + atomic commit
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.bank_import_staging (
  batch_id uuid not null,
  seq integer not null check (seq >= 0),
  client_id uuid not null references public.clients(id) on delete cascade,
  account_label text not null,
  row_count integer not null check (row_count >= 0),
  rows jsonb not null check (jsonb_typeof(rows) = 'array'),
  created_at timestamptz not null default now(),
  primary key (batch_id, seq)
);

create index if not exists bank_import_staging_created_idx on public.bank_import_staging (created_at);

alter table public.bank_import_staging enable row level security;
-- No policies: only the server (service role) uses it.
revoke all on table public.bank_import_staging from public, anon, authenticated;
grant select, insert, update, delete on table public.bank_import_staging to service_role;

-- One chunk of a batch (p_rows: [{txn_date, description, amount, reference, dedupe_key}]).
-- A retried chunk replaces itself. Returns the number of rows staged.
create or replace function public.stage_bank_import_chunk(
  p_batch_id uuid,
  p_client_id uuid,
  p_account_label text,
  p_seq integer,
  p_rows jsonb
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_count integer;
begin
  if p_batch_id is null or p_client_id is null or p_account_label is null or p_seq is null
     or p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'bank_import_bad_chunk' using errcode = '22023';
  end if;
  v_count := jsonb_array_length(p_rows);

  insert into public.bank_import_staging as s (batch_id, seq, client_id, account_label, row_count, rows)
  values (p_batch_id, p_seq, p_client_id, p_account_label, v_count, p_rows)
  on conflict (batch_id, seq) do update
    set rows = excluded.rows, row_count = excluded.row_count, created_at = now()
    where s.client_id = excluded.client_id and s.account_label = excluded.account_label;

  -- Housekeeping: batches that were never committed (crashed / cut requests).
  if random() < 0.05 then
    delete from public.bank_import_staging where created_at < now() - interval '1 day';
  end if;

  return v_count;
end;
$$;

revoke execute on function public.stage_bank_import_chunk(uuid, uuid, text, integer, jsonb) from public, anon, authenticated;
grant execute on function public.stage_bank_import_chunk(uuid, uuid, text, integer, jsonb) to service_role;

-- Moves a fully staged batch into bank_transactions: ONE statement, so all or nothing. Lines
-- already imported (same client + account label + dedupe key) are skipped. Refuses a batch that
-- is incomplete (p_chunks / p_rows don't match what was staged) or staged for another client.
-- statement_timeout: PostgREST applies a function's statement_timeout setting to the RPC call, so
-- the commit is not cut by the 8 s authenticator default (the request itself is cut at ~28 s).
create or replace function public.commit_bank_import(
  p_batch_id uuid,
  p_client_id uuid,
  p_account_label text,
  p_source_file text,
  p_chunks integer,
  p_rows integer
)
returns integer
language plpgsql
security invoker
set search_path = ''
set statement_timeout = '20s'
as $$
declare
  v_chunks integer;
  v_rows integer;
  v_foreign integer;
  v_inserted integer;
begin
  select count(*), coalesce(sum(s.row_count), 0),
         count(*) filter (where s.client_id <> p_client_id or s.account_label <> p_account_label)
  into v_chunks, v_rows, v_foreign
  from public.bank_import_staging s
  where s.batch_id = p_batch_id;

  if v_foreign > 0 then
    raise exception 'bank_import_batch_mismatch: batch % belongs to another client / account', p_batch_id
      using errcode = '22023';
  end if;
  if v_chunks <> p_chunks or v_rows <> p_rows then
    raise exception 'bank_import_incomplete: % of % chunks, % of % rows staged', v_chunks, p_chunks, v_rows, p_rows
      using errcode = '22023';
  end if;

  insert into public.bank_transactions (
    client_id, account_label, txn_date, description, amount, reference,
    matched_invoice_id, match_status, rejected_invoice_ids, dedupe_key, import_batch_id, source_file
  )
  select
    p_client_id, p_account_label, r.txn_date, coalesce(r.description, ''), r.amount, r.reference,
    null, 'unmatched', '{}', r.dedupe_key, p_batch_id, p_source_file
  from public.bank_import_staging s
  cross join lateral jsonb_to_recordset(s.rows)
    as r(txn_date date, description text, amount numeric, reference text, dedupe_key text)
  where s.batch_id = p_batch_id
  on conflict (client_id, account_label, dedupe_key) do nothing;
  get diagnostics v_inserted = row_count;

  delete from public.bank_import_staging where batch_id = p_batch_id;
  return v_inserted;
end;
$$;

revoke execute on function public.commit_bank_import(uuid, uuid, text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.commit_bank_import(uuid, uuid, text, text, integer, integer) to service_role;

-- The single-call import (up to one chunk, 2,500 rows) gets the same headroom.
alter function public.import_bank_transactions(uuid, text, uuid, text, jsonb) set statement_timeout = '20s';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Bookkeeping code formats (new writes only)
-- ─────────────────────────────────────────────────────────────────────────────
-- Israeli VAT / company id: 9 digits, Luhn-style check digit (same as src/shared/vatId.ts).
create or replace function public.is_valid_il_vat_id(p_value text)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  i integer;
  d integer;
  s integer := 0;
begin
  if p_value is null or p_value !~ '^\d{9}$' then
    return false;
  end if;
  for i in 1..9 loop
    d := substr(p_value, i, 1)::integer;
    if i % 2 = 0 then
      d := d * 2;
      if d > 9 then d := d - 9; end if;
    end if;
    s := s + d;
  end loop;
  return s % 10 = 0;
end;
$$;

create or replace function public.account_mappings_check_codes()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (tg_op = 'INSERT' or new.account_code is distinct from old.account_code)
     and coalesce(new.account_code, '') <> ''
     and new.account_code !~ '^\d{1,15}$' then
    raise exception 'account_mappings.account_code must be digits only (up to 15)'
      using errcode = '23514';
  end if;
  if (tg_op = 'INSERT' or new.vat_id is distinct from old.vat_id)
     and coalesce(new.vat_id, '') <> ''
     and not public.is_valid_il_vat_id(new.vat_id) then
    raise exception 'account_mappings.vat_id must be a valid 9-digit Israeli VAT id'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists account_mappings_check_codes on public.account_mappings;
create trigger account_mappings_check_codes
  before insert or update of account_code, vat_id on public.account_mappings
  for each row execute function public.account_mappings_check_codes();

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. clients: vat_account format + server-only contact_email
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.clients_check_writes()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (tg_op = 'INSERT' or new.vat_account is distinct from old.vat_account)
     and coalesce(new.vat_account, '') <> ''
     and new.vat_account !~ '^\d{1,15}$' then
    raise exception 'clients.vat_account must be digits only (up to 15)'
      using errcode = '23514';
  end if;

  -- contact_email is feature-flagged (accountant_review_loop): only the server writes it, after
  -- checking the flag (PUT /api/clients/[id]/contact-email). Members' direct writes are refused.
  if current_user in ('authenticated', 'anon')
     and ((tg_op = 'INSERT' and new.contact_email is not null)
          or (tg_op = 'UPDATE' and new.contact_email is distinct from old.contact_email)) then
    raise exception 'clients.contact_email can only be changed through the application'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists clients_check_writes on public.clients;
create trigger clients_check_writes
  before insert or update on public.clients
  for each row execute function public.clients_check_writes();
