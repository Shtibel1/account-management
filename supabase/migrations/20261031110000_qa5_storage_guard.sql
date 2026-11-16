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
--    Every invoice counts, whatever its client_id (an invoice moved to another client still
--    points at the file under the old client's folder).
-- 3. SELECT / INSERT keep can_access_storage_object() unchanged.
-- 4. The references themselves can't be cleared or repointed from the browser: invoices_status_guard
--    now also blocks browser changes of file_url, original_file_url and client_id (else a member
--    could PATCH them away over PostgREST and then delete the file).
-- The app's own delete paths (DELETE /api/invoices/[id], DELETE /api/clients/[id] via
-- src/lib/clientDeletion.ts, split cleanup) use the service role, which bypasses RLS: unaffected.
-- Idempotent: safe to run more than once.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Helpers
-- ─────────────────────────────────────────────────────────────────────────────

-- Percent-decoding of a URL path (file_url encodes each path segment with encodeURIComponent,
-- src/lib/ingestHelpers.ts storageReferenceUrl). A '%' not followed by two hex digits stays as is;
-- bytes that aren't valid UTF-8 raise an error (storage_path_decode() catches it).
create or replace function public.storage_path_decode_strict(p text)
returns text
language sql
immutable
set search_path = ''
as $$
  select coalesce(convert_from(string_agg(
           case when t.m[1] is not null then decode(substr(t.m[1], 2), 'hex') else convert_to(t.m[2], 'UTF8') end,
           ''::bytea order by t.n), 'UTF8'), '')
  from regexp_matches(p, '(%[0-9A-Fa-f]{2})|([^%]+|%)', 'g') with ordinality as t(m, n)
$$;

-- Malformed input (not valid UTF-8 once decoded) is returned as is.
create or replace function public.storage_path_decode(p text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p is null or position('%' in p) = 0 then
    return p;
  end if;
  return public.storage_path_decode_strict(p);
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
-- original of a split). Every invoice counts, not only those of the path's client: an invoice
-- moved to another client still points at the file under the old client's folder.
-- Conservative on purpose: any reference that can't be ruled out blocks.
create or replace function public.can_delete_storage_object(object_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.can_access_storage_object(object_name)
    and not exists (
      select 1
      from public.invoices i
      where i.status::text <> 'error'
        and (
          public.invoice_file_object_path(i.file_url) = object_name
          or public.invoice_file_object_path(i.original_file_url) = object_name
        )
    )
$$;

revoke execute on function public.storage_path_decode_strict(text) from public, anon;
revoke execute on function public.storage_path_decode(text) from public, anon;
revoke execute on function public.invoice_file_object_path(text) from public, anon;
revoke execute on function public.can_delete_storage_object(text) from public, anon;
grant execute on function public.storage_path_decode_strict(text) to authenticated, service_role;
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

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Invoice file references (invoices_status_guard)
-- ─────────────────────────────────────────────────────────────────────────────
-- invoices_member_all lets a member UPDATE any column of their office's invoices over PostgREST.
-- Clearing or repointing file_url / original_file_url, or moving the invoice to another client,
-- would take the stored original out of can_delete_storage_object()'s view (and rewriting the file
-- of a finished invoice tampers with the evidence by itself). These columns are set only by the
-- service role (ingest, split) and PATCH /api/invoices/[id] (client_id, after its access check).
-- Same function as 20261030160000_qa_status_integrity.sql (search_path from
-- 20261030170000_advisor_hardening.sql) plus the three columns.
create or replace function public.invoices_status_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_browser boolean := current_user in ('authenticated', 'anon');
begin
  if tg_op = 'INSERT' then
    -- Uploads go through the API (service role). A browser session may only create a document
    -- waiting to be processed, never an already approved / exported / reviewed one.
    if v_browser
       and (new.status::text <> 'processing'
            or new.reviewed_at is not null
            or new.exported_at is not null) then
      raise exception 'invoice_status_api_only: new invoices start in processing'
        using errcode = 'P0001';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    -- Only failed documents are deleted, through DELETE /api/invoices/[id].
    if v_browser then
      raise exception 'invoice_status_api_only: invoice % is deleted through the API only', old.id
        using errcode = 'P0001';
    end if;
    return old;
  end if;

  -- UPDATE
  if new.status is distinct from old.status
     and old.status::text = 'exported'
     and coalesce(current_setting('app.invoice_reopen', true), '') <> 'on' then
    raise exception 'invoice_exported_final: invoice % is exported; reopen it explicitly', old.id
      using errcode = 'P0001';
  end if;

  if v_browser
     and (new.status is distinct from old.status
          or new.reviewed_at is distinct from old.reviewed_at
          or new.exported_at is distinct from old.exported_at
          or new.validated_data is distinct from old.validated_data
          or new.ai_confidence is distinct from old.ai_confidence) then
    raise exception 'invoice_status_api_only: invoice % status/approval fields change through the API only', old.id
      using errcode = 'P0001';
  end if;

  if v_browser
     and (new.file_url is distinct from old.file_url
          or new.original_file_url is distinct from old.original_file_url
          or new.client_id is distinct from old.client_id) then
    raise exception 'invoice_file_api_only: invoice % file / client fields change through the API only', old.id
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;
