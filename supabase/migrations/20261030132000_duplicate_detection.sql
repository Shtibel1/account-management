-- Duplicate / fraud detection: file fingerprints, dismissed pairs, indexed candidate lookup.
-- Matching rules live in src/shared/duplicates.ts; the RPC below only narrows the candidates.

-- 1. File fingerprint: SHA-256 (hex) of the stored file bytes, set at upload / split time.
alter table public.invoices
  add column if not exists file_hash text;

create index if not exists invoices_client_file_hash_idx
  on public.invoices (client_id, file_hash)
  where file_hash is not null;

-- 2. Invoice-number normalization (keep in sync with normalizeInvoiceNumber in src/shared/duplicates.ts):
-- alphanumerics only, upper-case, no leading zeros; empty -> null.
create or replace function public.normalize_invoice_number(value text)
returns text
language sql
immutable
parallel safe
as $$
  select nullif(ltrim(upper(regexp_replace(coalesce(value, ''), '[^0-9A-Za-z]', '', 'g')), '0'), '')
$$;

-- Reviewer-approved values win over the AI extraction, field by field (same as the app).
create index if not exists invoices_client_invoice_number_idx
  on public.invoices (
    client_id,
    public.normalize_invoice_number(coalesce(validated_data->>'invoice_number', extracted_data->>'invoice_number'))
  );

create index if not exists invoices_client_invoice_date_idx
  on public.invoices (client_id, (coalesce(validated_data->>'invoice_date', extracted_data->>'invoice_date')));

-- 3. Pairs the reviewer marked as "not a duplicate". Order-independent: (a, b) == (b, a).
create table if not exists public.duplicate_dismissals (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  invoice_id uuid not null references public.invoices(id) on delete cascade,        -- the invoice being reviewed
  other_invoice_id uuid not null references public.invoices(id) on delete cascade,  -- the suspected duplicate
  dismissed_at timestamptz not null default now(),
  check (invoice_id <> other_invoice_id)
);

create unique index if not exists duplicate_dismissals_pair_idx
  on public.duplicate_dismissals (least(invoice_id, other_invoice_id), greatest(invoice_id, other_invoice_id));
create index if not exists duplicate_dismissals_invoice_idx on public.duplicate_dismissals (invoice_id);
create index if not exists duplicate_dismissals_other_invoice_idx on public.duplicate_dismissals (other_invoice_id);

alter table public.duplicate_dismissals enable row level security;

-- Same access model as the other tables for now (anon = the app).
-- TODO: replace with per-tenant policies before opening the app to outside users.
create policy allow_all_duplicate_dismissals on public.duplicate_dismissals
  for all to anon using (true) with check (true);

-- 4. Candidate pre-filter for one invoice: same file, same normalized invoice number, or an
-- invoice date inside [p_date_from, p_date_to] (YYYY-MM-DD strings compare correctly as text).
-- Excludes the invoice itself and rejected invoices; the app applies the exact rules.
create or replace function public.find_duplicate_candidates(
  p_client_id uuid,
  p_invoice_id uuid,
  p_file_hash text default null,
  p_invoice_number text default null,
  p_date_from text default null,
  p_date_to text default null
)
returns setof public.invoices
language sql
stable
security invoker
set search_path = public
as $$
  select i.*
  from public.invoices i
  where i.client_id = p_client_id
    and i.id <> p_invoice_id
    and i.status is distinct from 'rejected'
    and (
      (p_file_hash is not null and i.file_hash = p_file_hash)
      or (
        p_invoice_number is not null
        and public.normalize_invoice_number(coalesce(i.validated_data->>'invoice_number', i.extracted_data->>'invoice_number'))
            = p_invoice_number
      )
      or (
        p_date_from is not null and p_date_to is not null
        and coalesce(i.validated_data->>'invoice_date', i.extracted_data->>'invoice_date') between p_date_from and p_date_to
      )
    )
  order by i.created_at desc
  limit 500
$$;

grant execute on function public.find_duplicate_candidates(uuid, uuid, text, text, text, text) to anon;
grant execute on function public.normalize_invoice_number(text) to anon;
