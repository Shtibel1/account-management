-- QA round 3: invoices.reject_reason (20261030183000_qa2_ui2) was kept after the invoice left
-- 'rejected' (reopen_invoice() never cleared it), so a stale reason came back with the next
-- rejection screen / export of the row. The reason belongs to the rejected state only: a trigger
-- clears it on every write that leaves (or never was in) 'rejected' - reopen_invoice(), the
-- approve / return routes, the pipeline - and the stale rows are cleaned once.
-- The rejection itself stays logged in invoice_status_events. Idempotent: safe to run more than once.

create or replace function public.invoices_clear_reject_reason()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status::text <> 'rejected' then
    new.reject_reason := null;
  end if;
  return new;
end;
$$;

revoke execute on function public.invoices_clear_reject_reason() from public, anon, authenticated;

drop trigger if exists invoices_clear_reject_reason on public.invoices;
create trigger invoices_clear_reject_reason
  before insert or update on public.invoices
  for each row
  when (new.reject_reason is not null and new.status::text <> 'rejected')
  execute function public.invoices_clear_reject_reason();

-- Rows already left with a reason they no longer have
update public.invoices
set reject_reason = null
where status::text <> 'rejected'
  and reject_reason is not null;
