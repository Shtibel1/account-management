-- /bank search by amount as displayed (UX round, 2026-10-31).
-- The amount was only matched as trim_scale(abs(amount))::text ("123.4", "1234.56", "500"), so the
-- amounts the table shows - "123.40", "500.00", "1,234.56", "-1,234.56", "₪500" - found nothing.
-- A numeric query is now normalized (no ₪ / spaces / commas / leading minus) and also matched
-- against the 2-decimal text of abs(amount). Text search is unchanged; same signature and grants.
-- Mirrors normalizeAmountSearch() / filterBankTransactions() in src/shared/bankOverview.ts.

create or replace function public.bank_overview(
  p_client_id uuid,
  p_mode text default 'all',
  p_status text default 'all',
  p_account text default null,
  p_search text default '',
  p_page integer default 1,
  p_page_size integer default 25,
  p_details boolean default true
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_search text := lower(btrim(coalesce(p_search, '')));
  -- The query as an amount, the way the table shows it ("-1,234.56", "₪500.00", "123.40"):
  -- without ₪ / spaces / thousands commas / a leading minus. Null when it isn't a number.
  v_amount_search text := case
    when regexp_replace(v_search, '[\s₪,]', '', 'g') ~ '^[-−]?[0-9]+(\.[0-9]*)?$'
      then regexp_replace(regexp_replace(v_search, '[\s₪,]', '', 'g'), '^[-−]', '')
  end;
  v_size integer := least(greatest(coalesce(p_page_size, 25), 1), 1000);
  v_where text := 't.client_id = $1';
  v_total integer;
  v_pages integer;
  v_page integer;
  v_rows jsonb;
  v_result jsonb;
  v_summary jsonb;
  v_labels jsonb;
  v_matchable jsonb;
  v_used jsonb;
begin
  if p_mode = 'missing' then
    v_where := v_where || ' and t.match_status = ''unmatched'' and t.amount < 0';
  elsif p_status = 'debits' then
    v_where := v_where || ' and t.amount < 0';
  elsif p_status in ('unmatched', 'auto', 'manual', 'ignored') then
    v_where := v_where || ' and t.match_status = $2';
  end if;
  if p_account is not null then
    v_where := v_where || ' and t.account_label = $3';
  end if;
  if v_search <> '' then
    v_where := v_where || $w$ and (
      strpos(lower(t.description), $4) > 0
      or strpos(lower(coalesce(t.reference, '')), $4) > 0
      or strpos(lower(t.account_label), $4) > 0
      or strpos(trim_scale(abs(t.amount))::text, $4) > 0
      or ($7 is not null and (
        strpos(trim_scale(abs(t.amount))::text, $7) > 0
        or strpos(to_char(abs(t.amount), 'FM999999999990.00'), $7) > 0
      ))
      or (t.matched_invoice_id is not null and exists (
        select 1
        from public.invoices i
        cross join lateral (
          select coalesce(nullif(i.validated_data, 'null'::jsonb), nullif(i.extracted_data, 'null'::jsonb)) as d
        ) x
        where i.id = t.matched_invoice_id
          and i.client_id = $1
          and jsonb_typeof(x.d) = 'object'
          and (
            strpos(lower(coalesce(x.d ->> 'supplier_name', '')), $4) > 0
            or strpos(lower(coalesce(x.d ->> 'invoice_number', '')), $4) > 0
          )
      ))
    )$w$;
  end if;

  execute 'select count(*) from public.bank_transactions t where ' || v_where
    into v_total
    using p_client_id, p_status, p_account, v_search, null::integer, null::integer, v_amount_search;

  v_pages := greatest(1, ceil(v_total::numeric / v_size)::integer);
  v_page := least(greatest(coalesce(p_page, 1), 1), v_pages);

  execute
    'select coalesce(jsonb_agg(to_jsonb(p) order by p.txn_date desc, p.account_label, p.dedupe_key), ''[]''::jsonb) from ('
    || 'select t.* from public.bank_transactions t where ' || v_where
    || ' order by t.txn_date desc, t.account_label, t.dedupe_key limit $5 offset $6) p'
    into v_rows
    using p_client_id, p_status, p_account, v_search, v_size, (v_page - 1) * v_size, v_amount_search;

  v_result := jsonb_build_object(
    'transactions', v_rows,
    'total', v_total,
    'page', v_page,
    'pageSize', v_size,
    'totalPages', v_pages
  );
  if not coalesce(p_details, true) then
    return v_result;
  end if;

  select jsonb_build_object(
    'total', count(*),
    'debits', count(*) filter (where t.match_status <> 'ignored' and t.amount < 0),
    'matched', count(*) filter (where t.match_status in ('auto', 'manual') and t.amount < 0),
    'missing', count(*) filter (where t.match_status = 'unmatched' and t.amount < 0),
    'missingSum', coalesce(round(sum(-t.amount) filter (where t.match_status = 'unmatched' and t.amount < 0), 2), 0),
    'ignored', count(*) filter (where t.match_status = 'ignored')
  )
  into v_summary
  from public.bank_transactions t
  where t.client_id = p_client_id;

  -- Code point order, like [...labels].sort() in JS
  select coalesce(jsonb_agg(l.account_label order by l.account_label collate "C"), '[]'::jsonb)
  into v_labels
  from (
    select distinct t.account_label
    from public.bank_transactions t
    where t.client_id = p_client_id and t.account_label <> ''
  ) l;

  with inv as (
    select
      i.id,
      i.file_name,
      i.status,
      coalesce(nullif(i.validated_data, 'null'::jsonb), nullif(i.extracted_data, 'null'::jsonb)) as d,
      exists (
        select 1 from public.bank_transactions u
        where u.matched_invoice_id = i.id and u.client_id = p_client_id
      ) as used
    from public.invoices i
    where i.client_id = p_client_id
      and i.status in ('approved', 'exported')
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'id', inv.id,
      'file_name', inv.file_name,
      'status', inv.status,
      'supplier_name', case when jsonb_typeof(inv.d) = 'object' then inv.d ->> 'supplier_name' end,
      'invoice_number', case when jsonb_typeof(inv.d) = 'object' then inv.d ->> 'invoice_number' end,
      'invoice_date', case when jsonb_typeof(inv.d) = 'object' then inv.d ->> 'invoice_date' end,
      'total_amount', case
        when jsonb_typeof(inv.d) = 'object' and jsonb_typeof(inv.d -> 'total_amount') = 'number'
          then inv.d -> 'total_amount'
      end
    ) order by inv.id), '[]'::jsonb),
    coalesce(jsonb_agg(inv.id order by inv.id) filter (where inv.used), '[]'::jsonb)
  into v_matchable, v_used
  from inv;

  return v_result || jsonb_build_object(
    'summary', v_summary || jsonb_build_object('accountLabels', v_labels),
    'matchable', v_matchable,
    'used_invoice_ids', v_used
  );
end;
$$;

revoke execute on function public.bank_overview(uuid, text, text, text, text, integer, integer, boolean) from public, anon;
grant execute on function public.bank_overview(uuid, text, text, text, text, integer, integer, boolean) to authenticated, service_role;
