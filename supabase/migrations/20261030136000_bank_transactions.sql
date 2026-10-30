-- Bank / credit-card statement lines, matched against approved invoices (Dext Bank Match style).
-- Unmatched debits = "missing invoices" the accountant asks the client for.

create table if not exists public.bank_transactions (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  account_label text not null default '',           -- e.g. "לאומי 12-345" / "ויזה 1234"
  txn_date date not null,
  description text not null default '',
  amount numeric(14, 2) not null,                     -- negative = debit (money out)
  reference text,
  matched_invoice_id uuid references public.invoices(id) on delete set null,
  match_status text not null default 'unmatched'
    check (match_status in ('unmatched', 'auto', 'manual', 'ignored')),
  -- Invoices the reviewer un-matched from this line; auto-match won't propose them again.
  rejected_invoice_ids uuid[] not null default '{}',
  -- Built by bankDedupeKeys() in src/shared/bankStatement.ts (date|amount|description|reference#occurrence).
  dedupe_key text not null,
  import_batch_id uuid not null,
  source_file text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bank_transactions_match_consistent
    check ((match_status in ('auto', 'manual')) = (matched_invoice_id is not null))
);

-- Re-importing the same (or an overlapping) statement is idempotent.
create unique index if not exists bank_transactions_dedupe_idx
  on public.bank_transactions (client_id, account_label, dedupe_key);

-- One invoice can pay off only one statement line.
create unique index if not exists bank_transactions_invoice_once_idx
  on public.bank_transactions (matched_invoice_id)
  where matched_invoice_id is not null;

create index if not exists bank_transactions_client_date_idx
  on public.bank_transactions (client_id, txn_date desc);

create index if not exists bank_transactions_client_status_idx
  on public.bank_transactions (client_id, match_status);

-- When a matched invoice is deleted (ON DELETE SET NULL) the line goes back to unmatched
-- instead of violating bank_transactions_match_consistent.
create or replace function public.bank_transactions_before_update()
returns trigger
language plpgsql
as $$
begin
  if new.matched_invoice_id is null and new.match_status in ('auto', 'manual') then
    new.match_status := 'unmatched';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists bank_transactions_before_update on public.bank_transactions;
create trigger bank_transactions_before_update
  before update on public.bank_transactions
  for each row execute function public.bank_transactions_before_update();

alter table public.bank_transactions enable row level security;

-- Same access model as the other tables for now (anon = the app).
-- TODO: replace with per-tenant policies before opening the app to outside users.
create policy allow_all_bank_transactions on public.bank_transactions
  for all to anon using (true) with check (true);
