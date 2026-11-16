-- QA round 2 (ui2), finding N27: rejecting an invoice ("לא מאושר") asks for confirmation and an
-- optional reason. The reason is kept on the invoice (shown while it is rejected) and every
-- rejection is logged in invoice_status_events next to reopens.

alter table public.invoices
  add column if not exists reject_reason text
    check (reject_reason is null or length(reject_reason) <= 500);

comment on column public.invoices.reject_reason is
  'Optional reason given when the invoice was marked rejected (POST /api/invoices/[id]/reject). Shown only while status = rejected.';

-- invoice_status_events.action: allow 'reject' as well as 'reopen'
do $$
declare
  v_name text;
begin
  for v_name in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public'
      and rel.relname = 'invoice_status_events'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%action%'
  loop
    execute format('alter table public.invoice_status_events drop constraint %I', v_name);
  end loop;
end;
$$;

alter table public.invoice_status_events
  add constraint invoice_status_events_action_check
  check (action in ('reopen', 'reject'));
