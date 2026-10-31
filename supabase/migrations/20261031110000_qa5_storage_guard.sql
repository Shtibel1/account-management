-- QA round 5 #1: office members could destroy the stored original of a finished invoice.
--
-- raw_invoices_member_update / raw_invoices_member_delete (20261030140000_auth_tenancy.sql) only
-- checked can_access_storage_object(name), i.e. membership of the office that owns the client in
-- the first path segment. So any member could overwrite (upsert) or delete, through the Storage API,
-- the file of an approved, rejected, returned or exported invoice - the evidence behind the books.
--
-- Now, for browser sessions (role authenticated):
-- 1. No UPDATE of stored files at all (raw_invoices_member_update is dropped). The app never needs
--    it: browser uploads go through signed upload URLs issued by POST /api/invoices/upload-url
--    (without upsert, and Storage runs signed uploads as its own superuser, not under these
--    policies); every other write (ingest, split, plugins) uses the service role.
-- 2. DELETE only of objects that no invoice depends on: not referenced by any invoices.file_url /
--    original_file_url, or referenced only by invoices in status 'error' - the app's own delete
--    rule (DELETABLE_STATUSES in src/shared/invoiceStatus.ts). See can_delete_storage_object().
-- 3. SELECT / INSERT keep can_access_storage_object() unchanged.
-- The app's own delete paths (DELETE /api/invoices/[id], DELETE /api/clients/[id] via
-- src/lib/clientDeletion.ts, split cleanup) use the service role, which bypasses RLS: unaffected.
-- Idempotent: safe to run more than once.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Helpers
-- ─────────────────────────────────────────────────────────────────────────────

-- Percent-decoding of a URL path (file_url encodes each path segment with encodeURIComponent,
-- src/lib/ingestHelpers.ts storageReferenceUrl). Malformed input is returned as is.
create or replace function public.storage_path_decode(p text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_out bytea := ''::bytea;
  v_i integer := 1;
  v_n integer := length(coalesce(p, ''));
  v_c text;
begin
  if p is null or position('%' in p) = 0 then
    return p;
  end if;
  while v_i <= v_n loop
    v_c := substr(p, v_i, 1);
    if v_c = '%' and substr(p, v_i + 1, 2) ~ '^[0-9A-Fa-f]{2}$' then
      v_out := v_out || decode(substr(p, v_i + 1, 2), 'hex');
      v_i := v_i + 3;
    else
      v_out := v_out || convert_to(v_c, 'UTF8');
      v_i := v_i + 1;
    end if;
  end loop;
  return convert_from(v_out, 'UTF8');
exception when others then
  return p;
end;
$$;

-- raw-invoices object path of an invoices.file_url / original_file_url value (any of the stored
-- forms: /storage/v1/object/{authenticated|sign|public}/raw-invoices/<path>[?token=...]), else null.
create or replace function public.invoice_file_object_path(p_url text)
returns text
language sql
immutable
set search_path = ''
as $$
  select public.storage_path_decode(
    substring(p_url from '/storage/v1/object/(?:authenticated|sign|public)/raw-invoices/([^?#]+)')
  )
$$;

-- True when the caller may delete this raw-invoices object: it belongs to a client of one of the
-- caller's offices AND no invoice outside status 'error' references it (as its file or as the
-- original of a split). Conservative on purpose: any reference that can't be ruled out blocks.
create or replace function public.can_delete_storage_object(object_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_client_id uuid;
begin
  if not public.can_access_storage_object(object_name) then
    return false;
  end if;
  -- can_access_storage_object() already checked that the first segment is a client uuid
  v_client_id := split_part(object_name, '/', 1)::uuid;

  return not exists (
    select 1
    from public.invoices i
    where i.client_id = v_client_id
      and i.status::text <> 'error'
      and (
        public.invoice_file_object_path(i.file_url) = object_name
        or public.invoice_file_object_path(i.original_file_url) = object_name
      )
  );
end;
$$;

revoke execute on function public.storage_path_decode(text) from public, anon;
revoke execute on function public.invoice_file_object_path(text) from public, anon;
revoke execute on function public.can_delete_storage_object(text) from public, anon;
grant execute on function public.storage_path_decode(text) to authenticated, service_role;
grant execute on function public.invoice_file_object_path(text) to authenticated, service_role;
grant execute on function public.can_delete_storage_object(text) to authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Storage policies (raw-invoices)
-- ─────────────────────────────────────────────────────────────────────────────
drop policy if exists raw_invoices_member_update on storage.objects;

drop policy if exists raw_invoices_member_delete on storage.objects;
create policy raw_invoices_member_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'raw-invoices' and public.can_delete_storage_object(name));
