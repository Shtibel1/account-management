-- Supabase security advisor follow-ups.

-- Trigger function: pin search_path (body uses public objects).
alter function public.invoices_status_guard() set search_path = public, pg_temp;

-- Trigger-only function: nobody needs to call it via /rest/v1/rpc.
revoke execute on function public.clients_default_org() from public, anon, authenticated;
