-- QA round 6: deleting a client must not remove files that other invoices still use.
-- An invoice moved to another client (PATCH /api/invoices/[id]) keeps its file under the old
-- client's folder, so src/lib/clientDeletion.ts asks which paths are still referenced before
-- removing anything, and also removes the deleted client's files that live in other folders.

-- Object paths (file and split original) of the client's invoices, in any folder.
create or replace function public.client_invoice_file_paths(p_client_id uuid)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(distinct p), '{}')
  from public.invoices i
  cross join lateral (values
    (public.invoice_file_object_path(i.file_url)),
    (public.invoice_file_object_path(i.original_file_url))
  ) v(p)
  where i.client_id = p_client_id and p is not null
$$;

-- The subset of p_paths that some invoice (any client, any status) still references.
create or replace function public.storage_paths_in_use(p_paths text[])
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(distinct p), '{}')
  from unnest(p_paths) p
  where exists (
    select 1 from public.invoices i
    where public.invoice_file_object_path(i.file_url) = p
       or public.invoice_file_object_path(i.original_file_url) = p
  )
$$;

revoke execute on function public.client_invoice_file_paths(uuid) from public, anon, authenticated;
revoke execute on function public.storage_paths_in_use(text[]) from public, anon, authenticated;
grant execute on function public.client_invoice_file_paths(uuid) to service_role;
grant execute on function public.storage_paths_in_use(text[]) to service_role;
