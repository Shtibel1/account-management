-- Track allocation_number (מספר הקצאה) in field_accuracy (keep in sync with TRACKED_FIELDS).
create or replace view public.field_accuracy with (security_invoker = true) as
with reviewed as (
  select id from public.invoices where reviewed_at is not null
),
fields(field) as (
  values ('supplier_name'), ('supplier_vat_id'), ('invoice_number'), ('invoice_date'),
         ('amount_before_vat'), ('vat_amount'), ('total_amount'), ('expense_category'),
         ('allocation_number'),
         ('bank_name'), ('bank_branch_code'), ('bank_branch_name'), ('bank_account')
)
select
  f.field,
  (select count(*) from reviewed) as reviewed_invoices,
  count(c.id) as corrections,
  case when (select count(*) from reviewed) = 0 then null
       else round(1 - count(c.id)::numeric / (select count(*) from reviewed), 4)
  end as accuracy
from fields f
left join public.invoice_corrections c
  on c.field = f.field and c.invoice_id in (select id from reviewed)
group by f.field
order by accuracy nulls last, f.field;
