-- Per-supplier few-shot examples for extraction (learning from reviewer corrections without training).
-- ocr_text: raw OCR text of the invoice, the input side of future examples.
-- fewshot_example_*: which reviewed invoices were shown to the model as examples (0 = none),
-- so accuracy with/without examples can be compared (see fewshot_accuracy below).

alter table public.invoices
  add column if not exists ocr_text text,
  add column if not exists fewshot_example_count integer,
  add column if not exists fewshot_example_ids uuid[];

-- Example lookup: reviewed invoices of a supplier, newest first (filtered by client in the app).
create index if not exists invoices_reviewed_supplier_vat_idx
  on public.invoices ((validated_data->>'supplier_vat_id'), reviewed_at desc)
  where reviewed_at is not null and ocr_text is not null;

-- Reviewed invoices grouped by whether extraction had few-shot examples.
create or replace view public.fewshot_accuracy with (security_invoker = true) as
with reviewed as (
  select
    i.id,
    case
      when i.fewshot_example_count is null then 'unknown'
      when i.fewshot_example_count = 0 then 'without_examples'
      else 'with_examples'
    end as fewshot,
    (select count(*) from public.invoice_corrections c where c.invoice_id = i.id) as corrections
  from public.invoices i
  where i.reviewed_at is not null
)
select
  fewshot,
  count(*) as reviewed_invoices,
  count(*) filter (where corrections > 0) as invoices_corrected,
  sum(corrections) as field_corrections,
  round(1 - (count(*) filter (where corrections > 0))::numeric / count(*), 4) as invoice_accuracy
from reviewed
group by fewshot
order by fewshot;

grant select on public.fewshot_accuracy to anon, authenticated, service_role;
