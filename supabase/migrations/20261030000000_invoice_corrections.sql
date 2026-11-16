-- Correction log: one row per field the reviewer changed relative to the AI output.
-- Feeds per-field / per-supplier accuracy metrics and future few-shot / supplier templates.

alter table public.invoices
  add column if not exists reviewed_at timestamptz;

create table if not exists public.invoice_corrections (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  client_id uuid references public.clients(id) on delete set null,
  supplier_vat_id text,
  field text not null,
  ai_value jsonb,
  corrected_value jsonb,
  created_at timestamptz not null default now(),
  unique (invoice_id, field)
);

create index if not exists invoice_corrections_field_idx on public.invoice_corrections (field);
create index if not exists invoice_corrections_supplier_idx on public.invoice_corrections (supplier_vat_id);

alter table public.invoice_corrections enable row level security;

-- Same access model as the other tables for now (anon = the app).
-- TODO: replace with per-tenant policies before opening the app to outside users.
create policy allow_all_corrections on public.invoice_corrections
  for all to anon using (true) with check (true);

-- Fields tracked for accuracy (keep in sync with TRACKED_FIELDS in src/lib/corrections.ts).
create or replace view public.field_accuracy with (security_invoker = true) as
with reviewed as (
  select id from public.invoices where reviewed_at is not null
),
fields(field) as (
  values ('supplier_name'), ('supplier_vat_id'), ('invoice_number'), ('invoice_date'),
         ('amount_before_vat'), ('vat_amount'), ('total_amount'), ('expense_category'),
         ('bank_name'), ('bank_branch_code'), ('bank_branch_name'), ('bank_account')
)
select
  f.field,
  (select count(*) from reviewed) as reviewed_invoices,
  count(c.id) as corrections,
  case when (select count(*) from reviewed) = 0 then null
       else round(1 - count(c.id)::numeric / (select count(*) from reviewed), 4)
  end as accuracy
from fields f
left join public.invoice_corrections c
  on c.field = f.field and c.invoice_id in (select id from reviewed)
group by f.field
order by accuracy nulls last, f.field;

-- Per supplier: how many reviewed invoices, how many needed any correction.
create or replace view public.supplier_accuracy with (security_invoker = true) as
with reviewed as (
  select
    coalesce(i.validated_data->>'supplier_vat_id', '') as supplier_vat_id,
    i.validated_data->>'supplier_name' as supplier_name,
    (select count(*) from public.invoice_corrections c where c.invoice_id = i.id) as corrections
  from public.invoices i
  where i.reviewed_at is not null
)
select
  supplier_vat_id,
  max(supplier_name) as supplier_name,
  count(*) as reviewed_invoices,
  count(*) filter (where corrections > 0) as invoices_corrected,
  sum(corrections) as field_corrections,
  round(1 - (count(*) filter (where corrections > 0))::numeric / count(*), 4) as invoice_accuracy
from reviewed
group by supplier_vat_id
order by reviewed_invoices desc;

grant select on public.field_accuracy, public.supplier_accuracy to anon, authenticated, service_role;
