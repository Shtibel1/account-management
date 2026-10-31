-- Learning from reviewer corrections (src/shared/learning.ts, src/lib/learning.ts).
--
-- extraction_learning_signals: one row per corrected field of an approved invoice, classified as
--   in_document (the corrected value is printed in the OCR text), not_in_document or user_typo.
--   Replaced on re-approval of the same invoice.
-- extraction_learned_rules: per office + client + supplier + field, the label the in-document
--   signals agree on ("for supplier X the invoice number is the value next to 'אסמכתא'").
--   Applied to the next extraction of that supplier while active (more agreeing than disagreeing
--   signals). Deleting a rule ("forget") also deletes its signals.
--
-- Written only by the server (service role). Office members may read them and delete (forget)
-- rules of their own office's clients.

create table if not exists public.extraction_learning_signals (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  supplier_key text not null,
  supplier_vat_id text,
  supplier_name text,
  field text not null,
  classification text not null check (classification in ('in_document', 'not_in_document', 'user_typo')),
  reason text,
  ai_value text,
  corrected_value text,
  label text,
  wrong_label text,
  line_offset smallint check (line_offset in (0, 1)),
  value_shape jsonb,
  created_at timestamptz not null default now(),
  unique (invoice_id, field)
);

create index if not exists extraction_learning_signals_key_idx
  on public.extraction_learning_signals (org_id, client_id, supplier_key, field, created_at desc);
create index if not exists extraction_learning_signals_client_idx
  on public.extraction_learning_signals (client_id);

create table if not exists public.extraction_learned_rules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  supplier_key text not null,
  supplier_vat_id text,
  supplier_name text,
  field text not null check (field in (
    'invoice_number', 'invoice_date', 'allocation_number', 'supplier_vat_id',
    'total_amount', 'vat_amount', 'amount_before_vat'
  )),
  label text not null,
  wrong_label text,
  line_offset smallint not null default 0 check (line_offset in (0, 1)),
  value_shape jsonb not null default '{}'::jsonb,
  support integer not null default 1 check (support >= 0),
  conflicts integer not null default 0 check (conflicts >= 0),
  active boolean not null default false,
  last_value text,
  last_wrong_value text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, client_id, supplier_key, field)
);

create index if not exists extraction_learned_rules_lookup_idx
  on public.extraction_learned_rules (org_id, supplier_key) where active;
create index if not exists extraction_learned_rules_client_idx
  on public.extraction_learned_rules (client_id);

-- A row's office must be its client's office (no rule of office A on a client of office B).
create or replace function public.learning_row_org_matches_client()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (select 1 from public.clients c where c.id = new.client_id and c.org_id = new.org_id) then
    raise exception 'org_id % does not match the office of client %', new.org_id, new.client_id
      using errcode = '23514';
  end if;
  return new;
end
$$;

drop trigger if exists extraction_learning_signals_org_check on public.extraction_learning_signals;
create trigger extraction_learning_signals_org_check
  before insert or update of org_id, client_id on public.extraction_learning_signals
  for each row execute function public.learning_row_org_matches_client();

drop trigger if exists extraction_learned_rules_org_check on public.extraction_learned_rules;
create trigger extraction_learned_rules_org_check
  before insert or update of org_id, client_id on public.extraction_learned_rules
  for each row execute function public.learning_row_org_matches_client();

alter table public.extraction_learning_signals enable row level security;
alter table public.extraction_learned_rules enable row level security;

revoke all on public.extraction_learning_signals from anon, authenticated;
revoke all on public.extraction_learned_rules from anon, authenticated;
grant select on public.extraction_learning_signals to authenticated;
grant select, delete on public.extraction_learned_rules to authenticated;
grant all on public.extraction_learning_signals to service_role;
grant all on public.extraction_learned_rules to service_role;

drop policy if exists extraction_learning_signals_member_select on public.extraction_learning_signals;
create policy extraction_learning_signals_member_select on public.extraction_learning_signals
  for select to authenticated
  using (public.is_org_member(org_id) and client_id in (select public.accessible_client_ids()));

drop policy if exists extraction_learned_rules_member_select on public.extraction_learned_rules;
create policy extraction_learned_rules_member_select on public.extraction_learned_rules
  for select to authenticated
  using (public.is_org_member(org_id) and client_id in (select public.accessible_client_ids()));

drop policy if exists extraction_learned_rules_member_delete on public.extraction_learned_rules;
create policy extraction_learned_rules_member_delete on public.extraction_learned_rules
  for delete to authenticated
  using (public.is_org_member(org_id) and client_id in (select public.accessible_client_ids()));
