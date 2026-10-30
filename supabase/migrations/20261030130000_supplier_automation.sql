-- Supplier rules + per-supplier auto-approve.
--
-- Supplier rules reuse account_mappings (mapping_type = 'supplier': key = canonical supplier name,
-- account_code = ledger account, vat_id, expense_category = default category). The app writes the
-- rule's values into invoices.validated_data (never extracted_data) and records them in
-- validated_data.supplier_rule. Precedence: explicit reviewer edit > supplier rule > AI.
--
-- Auto-approve: a supplier is ELIGIBLE (suggestion only) when its last 5 human-reviewed invoices
-- (reviewed_at not null) had no invoice_corrections rows (AUTO_APPROVE_HISTORY_SIZE in
-- src/shared/autoApprove.ts). The client opts the supplier in here; the app turns it off again when
-- a later human review of that supplier records corrections (disabled_reason = 'corrections').

-- Rule lookups by VAT ID
create index if not exists account_mappings_client_vat_idx
  on public.account_mappings (client_id, vat_id)
  where mapping_type = 'supplier';

-- Eligibility reads the reviewed history per client
create index if not exists invoices_client_reviewed_idx
  on public.invoices (client_id, reviewed_at desc)
  where reviewed_at is not null;

create index if not exists invoice_corrections_client_idx
  on public.invoice_corrections (client_id);

create table if not exists public.supplier_automation (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  supplier_vat_id text not null,            -- normalized: digits only, 9 digits
  auto_approve boolean not null default false,
  enabled_at timestamptz,
  disabled_at timestamptz,
  disabled_reason text check (disabled_reason in ('manual', 'corrections')),
  disabled_by_invoice_id uuid references public.invoices(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, supplier_vat_id)
);

alter table public.supplier_automation enable row level security;

-- Same access model as the other tables for now (anon = the app).
-- TODO: replace with per-tenant policies before opening the app to outside users.
create policy allow_all_supplier_automation on public.supplier_automation
  for all to anon using (true) with check (true);
