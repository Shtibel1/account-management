-- Export plugins: per-client bookkeeping integrations, per-invoice export status, integration logs.
-- See docs/integrations.md.
--
-- Access model (same as 20261030140000_auth_tenancy.sql):
--   * anon: nothing;
--   * authenticated: only rows of clients in organizations they are members of
--     (client_id in accessible_client_ids()), and only READ access. All writes go through the
--     server (service role) after the route guards in src/lib/auth.ts;
--   * client_integrations.config_encrypted (AES-256-GCM ciphertext of the plugin config, incl.
--     secrets) is not readable by authenticated at all (column-level grant): the browser only ever
--     sees config_masked.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. client_integrations: which plugin a client uses + its (encrypted) config
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.client_integrations (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  plugin_id text not null check (plugin_id ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  enabled boolean not null default true,
  environment text not null default 'sandbox' check (environment in ('sandbox', 'production')),
  -- "v1:<iv>:<tag>:<ciphertext>" (base64), AES-256-GCM with key INTEGRATIONS_ENCRYPTION_KEY and
  -- AAD "<client_id>:<plugin_id>". Null when the plugin has no config.
  config_encrypted text,
  -- Same keys as the config; secret values replaced by a mask ("••••1234"). Safe for the browser.
  config_masked jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint client_integrations_client_plugin_key unique (client_id, plugin_id)
);

create index if not exists client_integrations_client_idx on public.client_integrations (client_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. invoice_exports: per invoice + plugin export status (idempotency)
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.invoice_exports (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  plugin_id text not null check (plugin_id ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  status text not null default 'pending' check (status in ('pending', 'success', 'failed', 'skipped')),
  external_id text,
  external_url text,
  attempts integer not null default 0 check (attempts >= 0),
  last_error text,
  -- true when the last failed attempt may still have created the document in the target (timeout,
  -- connection lost after sending, 5xx on a write): the next run must not blindly re-send it.
  outcome_uncertain boolean not null default false,
  correlation_id uuid,
  exported_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint invoice_exports_invoice_plugin_key unique (invoice_id, plugin_id)
);

create index if not exists invoice_exports_client_idx on public.invoice_exports (client_id, plugin_id);

-- The row's client must be the invoice's client (the server always writes both from the invoice).
create or replace function public.invoice_exports_check_client()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.invoices i where i.id = new.invoice_id and i.client_id = new.client_id) then
    raise exception 'invoice_exports: invoice % does not belong to client %', new.invoice_id, new.client_id;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

revoke execute on function public.invoice_exports_check_client() from public, anon, authenticated;

drop trigger if exists invoice_exports_check_client on public.invoice_exports;
create trigger invoice_exports_check_client
  before insert or update on public.invoice_exports
  for each row execute function public.invoice_exports_check_client();

create or replace function public.client_integrations_touch()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

revoke execute on function public.client_integrations_touch() from public, anon, authenticated;

drop trigger if exists client_integrations_touch on public.client_integrations;
create trigger client_integrations_touch
  before update on public.client_integrations
  for each row execute function public.client_integrations_touch();

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. integration_logs: one row per outbound HTTP attempt / integration operation
-- ─────────────────────────────────────────────────────────────────────────────
-- Written only by the server through src/integrations/http.ts, already redacted (auth headers,
-- known secret keys, the plugin's secret config fields and their values) and truncated to 20KB.
-- Retention: purge_integration_logs(days) below (default 90 days); see docs/integrations.md.

create table if not exists public.integration_logs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references public.organizations(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  plugin_id text not null,
  invoice_id uuid references public.invoices(id) on delete set null,
  correlation_id uuid not null,
  operation text not null,
  http_method text,
  url text,
  request_body text,
  response_status integer,
  response_body text,
  duration_ms integer,
  attempt integer not null default 1,
  outcome text not null check (outcome in ('ok', 'error', 'retry')),
  error_code text,
  error_message text,
  created_at timestamptz not null default now()
);

create index if not exists integration_logs_client_created_idx on public.integration_logs (client_id, created_at desc);
create index if not exists integration_logs_correlation_idx on public.integration_logs (correlation_id);
create index if not exists integration_logs_invoice_idx on public.integration_logs (invoice_id) where invoice_id is not null;

-- Retention: deletes log rows older than `days` (min 1). Service role only, e.g. a daily pg_cron job:
--   select cron.schedule('purge-integration-logs', '15 3 * * *', $$select public.purge_integration_logs(90)$$);
create or replace function public.purge_integration_logs(days integer default 90)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  delete from public.integration_logs
  where created_at < now() - make_interval(days => greatest(coalesce(days, 90), 1));
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke execute on function public.purge_integration_logs(integer) from public, anon, authenticated;
grant execute on function public.purge_integration_logs(integer) to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Row level security
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.client_integrations enable row level security;
alter table public.invoice_exports enable row level security;
alter table public.integration_logs enable row level security;

revoke all on public.client_integrations, public.invoice_exports, public.integration_logs from anon;
revoke all on public.client_integrations, public.invoice_exports, public.integration_logs from authenticated;

-- authenticated: read-only; config_encrypted is excluded by the column list.
grant select (id, client_id, plugin_id, enabled, environment, config_masked, created_at, updated_at)
  on public.client_integrations to authenticated;
grant select on public.invoice_exports, public.integration_logs to authenticated;
grant all on public.client_integrations, public.invoice_exports, public.integration_logs to service_role;

-- Policies are scoped exactly like the other tenant tables (using + with check by client). The
-- grants above make them read-only for authenticated today; if a browser write is ever granted,
-- the with check clauses already confine it to the user's own clients.
drop policy if exists client_integrations_member_all on public.client_integrations;
create policy client_integrations_member_all on public.client_integrations
  for all to authenticated
  using (client_id in (select public.accessible_client_ids()))
  with check (client_id in (select public.accessible_client_ids()));

drop policy if exists invoice_exports_member_all on public.invoice_exports;
create policy invoice_exports_member_all on public.invoice_exports
  for all to authenticated
  using (client_id in (select public.accessible_client_ids()))
  with check (
    client_id in (select public.accessible_client_ids())
    and exists (select 1 from public.invoices i where i.id = invoice_id and i.client_id = invoice_exports.client_id)
  );

drop policy if exists integration_logs_member_all on public.integration_logs;
create policy integration_logs_member_all on public.integration_logs
  for all to authenticated
  using (
    client_id in (select public.accessible_client_ids())
    and (org_id is null or public.is_org_member(org_id))
  )
  with check (
    client_id in (select public.accessible_client_ids())
    and (org_id is null or public.is_org_member(org_id))
  );
