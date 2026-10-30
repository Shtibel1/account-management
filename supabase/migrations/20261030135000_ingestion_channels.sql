-- Ingestion channels: per-client inbound email alias + WhatsApp contacts, and invoice source tracking.
-- See docs/ingestion.md. The app degrades gracefully until this is applied.

-- 1. Where each invoice came from.
alter table public.invoices
  add column if not exists source text not null default 'upload',
  add column if not exists source_sender text,
  add column if not exists source_ref text;

alter table public.invoices drop constraint if exists invoices_source_check;
alter table public.invoices
  add constraint invoices_source_check check (source in ('upload', 'email', 'whatsapp'));

-- Provider message id + attachment index; de-duplicates webhook retries.
create unique index if not exists invoices_source_ref_key
  on public.invoices (source_ref) where source_ref is not null;

-- 2. Inbound email alias: <alias>@INBOUND_EMAIL_DOMAIN. Random so it can't be guessed
--    (format kept in sync with generateInboundAlias in src/lib/ingestHelpers.ts).
alter table public.clients
  add column if not exists inbound_alias text;

update public.clients
  set inbound_alias = 'inv-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)
  where inbound_alias is null;

alter table public.clients
  alter column inbound_alias set default ('inv-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));

alter table public.clients drop constraint if exists clients_inbound_alias_key;
alter table public.clients
  add constraint clients_inbound_alias_key unique (inbound_alias);

-- 3. Phones allowed to send documents over WhatsApp, stored in E.164 (+972501234567).
--    A phone maps to exactly one client so the sender is unambiguous.
create table if not exists public.client_contacts (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  phone text not null unique check (phone ~ '^\+[1-9][0-9]{7,14}$'),
  name text,
  created_at timestamptz not null default now()
);

create index if not exists client_contacts_client_idx on public.client_contacts (client_id);

alter table public.client_contacts enable row level security;

-- Same access model as the other tables for now (anon = the app).
-- TODO: replace with per-tenant policies before opening the app to outside users.
drop policy if exists allow_all_client_contacts on public.client_contacts;
create policy allow_all_client_contacts on public.client_contacts
  for all to anon using (true) with check (true);
