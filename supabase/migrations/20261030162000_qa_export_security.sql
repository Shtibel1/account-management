-- QA export-security fixes (findings #31 and #34 of the 2026-10-30 QA run).
--
-- 1. invoices.file_url no longer holds 1-year signed (bearer) URLs.
--    The app now stores a storage REFERENCE, /storage/v1/object/authenticated/raw-invoices/<path>,
--    which needs a JWT to read, and signs short-lived URLs on demand (src/lib/invoiceFiles.ts:
--    10 minutes for the viewer via GET /api/invoices/[id]/file, 1 hour for a pipeline run).
--    Existing rows are rewritten here: the object path is taken from the signed URL and the token
--    (query string) is dropped. The old tokens themselves stay valid until they expire (Supabase
--    cannot revoke a signed URL short of rotating the JWT secret), but the app no longer stores,
--    returns or logs them.
--    (No generated file_path column: it would rewrite the table and make every write that sends
--    the full row fail; the app derives the object path from file_url - src/lib/invoiceFiles.ts.)
--    Object paths are ASCII-only (buildStoragePath / sanitizeStorageFilename), so the path in the
--    URL needs no percent-decoding.
--
-- 2. lead_rate_limits + lead_rate_limit_hit(): fixed-window counters for the public lead form
--    (POST /api/lead). Only the service role can use them; buckets carry a salted IP hash, never
--    the raw address.
--
-- Idempotent: safe to run more than once.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. invoices.file_url -> storage reference
-- ─────────────────────────────────────────────────────────────────────────────

update public.invoices
set file_url = regexp_replace(
  file_url,
  '^(https?://[^/]+)/storage/v1/object/sign/raw-invoices/([^?#]+).*$',
  '\1/storage/v1/object/authenticated/raw-invoices/\2'
)
where file_url ~ '^https?://[^/]+/storage/v1/object/sign/raw-invoices/[^?#]+';

-- Split lineage (20261030161000_qa_pipeline.sql): the original multi-page file of split parts.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'invoices' and column_name = 'original_file_url'
  ) then
    update public.invoices
    set original_file_url = regexp_replace(
      original_file_url,
      '^(https?://[^/]+)/storage/v1/object/sign/raw-invoices/([^?#]+).*$',
      '\1/storage/v1/object/authenticated/raw-invoices/\2'
    )
    where original_file_url ~ '^https?://[^/]+/storage/v1/object/sign/raw-invoices/[^?#]+';
  end if;
end;
$$;

comment on column public.invoices.file_url is
  'Storage reference of the original file (/storage/v1/object/authenticated/raw-invoices/<path>). Not a link: '
  'the app signs short-lived URLs on demand (src/lib/invoiceFiles.ts).';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Rate limiting of the public lead form
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.lead_rate_limits (
  bucket text not null check (length(bucket) <= 128),
  window_start timestamptz not null,
  hits integer not null default 0,
  primary key (bucket, window_start)
);

alter table public.lead_rate_limits enable row level security;
-- No policies: anon / authenticated have no access at all.
revoke all on table public.lead_rate_limits from public, anon, authenticated;
grant select, insert, update, delete on table public.lead_rate_limits to service_role;

-- Counts one hit in the current window of p_bucket; true while the count is <= p_max.
create or replace function public.lead_rate_limit_hit(p_bucket text, p_window_seconds integer, p_max integer)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_window integer := greatest(coalesce(p_window_seconds, 60), 1);
  v_start timestamptz;
  v_hits integer;
begin
  if p_bucket is null or length(p_bucket) = 0 or length(p_bucket) > 128 then
    return false;
  end if;
  v_start := to_timestamp(floor(extract(epoch from now()) / v_window) * v_window);

  insert into public.lead_rate_limits as l (bucket, window_start, hits)
  values (p_bucket, v_start, 1)
  on conflict (bucket, window_start) do update set hits = l.hits + 1
  returning l.hits into v_hits;

  -- Housekeeping: windows older than two days are never read again.
  if random() < 0.05 then
    delete from public.lead_rate_limits where window_start < now() - interval '2 days';
  end if;

  return v_hits <= coalesce(p_max, 0);
end;
$$;

revoke execute on function public.lead_rate_limit_hit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.lead_rate_limit_hit(text, integer, integer) to service_role;
