-- QA round 4: the bank page and the missing-invoices export loaded every line of the client.
--
-- GET /api/bank (loadBankOverview in src/lib/bankTransactions.ts) read EVERY bank_transactions row
-- of the client (1000 per request, one after the other) and filtered, sorted, paged and summarized
-- in JS: 12-20 s at 110k-130k lines (a search returning one row: 16.5 s), and the missing-invoices
-- export repeated that for each 500-line page. Now:
-- 1. bank_overview(): one call returning one filtered, sorted page of lines, the filtered count,
--    the summary over all lines and the client's matchable invoices (slim), all computed in SQL.
-- 2. bank_missing_lines(): the export's lines (unmatched debits, the sheet's columns only), keyset
--    paged by id, so every call is an index range scan whatever the page.
-- 3. bank_auto_match_input(): degrades instead of giving up (QA4 finding 2). An invoice with more
--    than p_max_per_invoice candidate lines is skipped (and its lines can't be auto-matched), and
--    when the remaining candidate lines still exceed p_max_lines, whole invoices are taken - the
--    ones with a line of p_prefer_batch_id (the import just done) first, then the fewest
--    candidates first - until the budget is used. One bad statement no longer disables
--    auto-matching for the client.
-- 1 and 2 are SECURITY INVOKER: called with a user's token, RLS (bank_transactions_member_all /
-- invoices policies) applies; the app calls them with the service role after requireClientAccess().
-- Not callable by anon. Idempotent: safe to run more than once.

-- ─────────────────────────────────────────────────────────────────────────────
-- Indexes
-- ─────────────────────────────────────────────────────────────────────────────
-- The page's display order (date desc, account, dedupe key): a page is read in index order and
-- the scan stops at the page's last row. Supersedes (client_id, txn_date desc).
create index if not exists bank_transactions_client_order_idx
  on public.bank_transactions (client_id, txn_date desc, account_label, dedupe_key);
drop index if exists public.bank_transactions_client_date_idx;

-- The "missing invoices" tab (unmatched debits) in display order, and its count.
create index if not exists bank_transactions_missing_order_idx
  on public.bank_transactions (client_id, txn_date desc, account_label, dedupe_key)
  where match_status = 'unmatched' and amount < 0;

-- The export's keyset paging over the unmatched debits.
create index if not exists bank_transactions_missing_id_idx
  on public.bank_transactions (client_id, id)
  where match_status = 'unmatched' and amount < 0;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. One page of the bank page
-- ─────────────────────────────────────────────────────────────────────────────
-- Same filters as filterBankTransactions() (src/shared/bankOverview.ts):
--   p_mode 'missing' = unmatched debits (p_status ignored); else p_status 'debits' = amount < 0,
--   'unmatched' / 'auto' / 'manual' / 'ignored' = that status, anything else = every line;
--   p_account null = every account ('' is a valid label); p_search = case-insensitive substring of
--   the description, reference, account label, the matched invoice's supplier / number, or the
--   amount without sign and trailing zeros (String(Math.abs(amount)) in JS).
-- The page is clamped into range like paginate(). Returns
--   {transactions, total, page, pageSize, totalPages}
-- plus, when p_details, {summary, matchable, used_invoice_ids}: the summary over ALL the client's
-- lines (summarizeBankTransactions()), the approved/exported invoices with the fields
-- toMatchableInvoice() reads, and which of them are already matched to a line.
-- The WHERE clause is built from the filters that are set (dynamic SQL, values passed as
-- parameters), so every call is planned for exactly its filters and can use the partial indexes.
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
    using p_client_id, p_status, p_account, v_search;

  v_pages := greatest(1, ceil(v_total::numeric / v_size)::integer);
  v_page := least(greatest(coalesce(p_page, 1), 1), v_pages);

  execute
    'select coalesce(jsonb_agg(to_jsonb(p) order by p.txn_date desc, p.account_label, p.dedupe_key), ''[]''::jsonb) from ('
    || 'select t.* from public.bank_transactions t where ' || v_where
    || ' order by t.txn_date desc, t.account_label, t.dedupe_key limit $5 offset $6) p'
    into v_rows
    using p_client_id, p_status, p_account, v_search, v_size, (v_page - 1) * v_size;

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

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Missing-invoices export, keyset paged
-- ─────────────────────────────────────────────────────────────────────────────
-- Unmatched debits of the client with the sheet's columns, ordered by id, after p_after (null =
-- from the start), at most p_limit (capped at 5000; ~120 bytes per line). jsonb, so PostgREST's
-- max-rows cap doesn't apply. The caller passes the last id as p_after for the next page and stops
-- at a page shorter than p_limit; the sheet is sorted by the exporter.
create or replace function public.bank_missing_lines(
  p_client_id uuid,
  p_after uuid default null,
  p_limit integer default 5000
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', l.id,
    'txn_date', l.txn_date,
    'account_label', l.account_label,
    'description', l.description,
    'reference', l.reference,
    'amount', l.amount
  ) order by l.id), '[]'::jsonb)
  from (
    select t.id, t.txn_date, t.account_label, t.description, t.reference, t.amount
    from public.bank_transactions t
    where t.client_id = p_client_id
      and t.match_status = 'unmatched'
      and t.amount < 0
      and (p_after is null or t.id > p_after)
    order by t.id
    limit least(greatest(coalesce(p_limit, 5000), 1), 5000)
  ) l;
$$;

revoke execute on function public.bank_missing_lines(uuid, uuid, integer) from public, anon;
grant execute on function public.bank_missing_lines(uuid, uuid, integer) to authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Auto-match input with a per-invoice cap
-- ─────────────────────────────────────────────────────────────────────────────
-- Same candidate rule as the QA3 version (migration 20261030192000). New:
--   - only invoices with 1..p_max_per_invoice candidate lines are taken ("selected"), the ones with
--     a line of p_prefer_batch_id first, then the fewest candidates first, while the running total
--     of their candidate lines stays within p_max_lines;
--   - only selected invoices (those with candidates) and their candidate lines are returned;
--   - a line that is also a candidate of an invoice that was NOT selected comes with
--     blocked = true: its candidate list is incomplete, so autoMatch() keeps it as a rival of the
--     selected invoices but never matches it itself (no pair is accepted without seeing all of
--     its competitors);
--   - truncated = some invoice with candidates was not selected; skipped_invoices = how many.
-- The QA3 5-argument version is kept unchanged on purpose: the build deployed before this one
-- calls it, and without it would fall back to paging every unmatched debit (the O(N) path QA3
-- removed) between this migration and the deploy. The calls can't be confused: PostgREST picks
-- the overload by the argument names sent, and this one requires p_max_per_invoice. Drop the
-- 5-argument one in a later migration, once every deployed build sends p_max_per_invoice.

create or replace function public.bank_auto_match_input(
  p_client_id uuid,
  p_tolerance numeric,
  p_max_lines integer,
  p_days_before integer,
  p_days_after integer,
  p_max_per_invoice integer,
  p_prefer_batch_id uuid default null
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with inv as (
    select
      i.id,
      i.file_name,
      i.status,
      coalesce(nullif(i.validated_data, 'null'::jsonb), nullif(i.extracted_data, 'null'::jsonb)) as d
    from public.invoices i
    where i.client_id = p_client_id
      and i.status in ('approved', 'exported')
      and not exists (select 1 from public.bank_transactions u where u.matched_invoice_id = i.id)
  ),
  m as (
    select
      inv.id,
      inv.file_name,
      inv.status,
      case when jsonb_typeof(inv.d) = 'object' then inv.d ->> 'supplier_name' end as supplier_name,
      case when jsonb_typeof(inv.d) = 'object' then inv.d ->> 'invoice_number' end as invoice_number,
      case when jsonb_typeof(inv.d) = 'object' then inv.d ->> 'invoice_date' end as invoice_date,
      -- Nested CASEs: the casts run only after the format check passed (AND has no fixed order)
      case
        when jsonb_typeof(inv.d) = 'object' and inv.d ->> 'invoice_date' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' then
          case
            when substring(inv.d ->> 'invoice_date' from 1 for 4)::integer >= 1 then (
              make_date(substring(inv.d ->> 'invoice_date' from 1 for 4)::integer, 1, 1)
              + make_interval(
                  months => substring(inv.d ->> 'invoice_date' from 6 for 2)::integer - 1,
                  days => substring(inv.d ->> 'invoice_date' from 9 for 2)::integer - 1
                )
            )::date
          end
      end as invoice_day,
      case
        when jsonb_typeof(inv.d) = 'object' and jsonb_typeof(inv.d -> 'total_amount') = 'number'
          then (inv.d ->> 'total_amount')::numeric
      end as total_amount
    from inv
  ),
  pairs as (
    select
      m.id as invoice_id,
      t.id as line_id,
      -- Never null (null would sort first under desc), whatever the line's batch
      coalesce(t.import_batch_id = p_prefer_batch_id, false) as in_batch
    from m
    join public.bank_transactions t
      on t.client_id = p_client_id
     and t.match_status = 'unmatched'
     and t.amount < 0
     and t.amount between -(m.total_amount + p_tolerance) and -(m.total_amount - p_tolerance)
     and t.txn_date between m.invoice_day - p_days_before and m.invoice_day + p_days_after
    where m.total_amount > 0
      and m.invoice_day is not null
  ),
  stats as (
    select p.invoice_id, count(*) as n, bool_or(p.in_batch) as in_batch
    from pairs p
    group by p.invoice_id
  ),
  ranked as (
    select
      s.invoice_id,
      sum(s.n) over (order by s.in_batch desc, s.n, s.invoice_id rows between unbounded preceding and current row) as running
    from stats s
    where s.n <= greatest(p_max_per_invoice, 1)
  ),
  sel as (
    select r.invoice_id from ranked r where r.running <= greatest(p_max_lines, 0)
  ),
  cand as (
    select distinct p.line_id
    from pairs p
    join sel on sel.invoice_id = p.invoice_id
  ),
  -- Lines that are also a candidate of a left-out invoice, computed once as a set (a hash
  -- anti-join + distinct) rather than probing pairs per returned line
  blocked_lines as (
    select distinct p.line_id
    from pairs p
    left join sel s on s.invoice_id = p.invoice_id
    where s.invoice_id is null
  ),
  lines as (
    select
      t.id, t.txn_date, t.description, t.amount, t.rejected_invoice_ids, t.import_batch_id,
      b.line_id is not null as blocked
    from cand
    join public.bank_transactions t on t.id = cand.line_id
    left join blocked_lines b on b.line_id = cand.line_id
  ),
  skipped as (
    select count(*) as n from stats s left join sel on sel.invoice_id = s.invoice_id where sel.invoice_id is null
  )
  select jsonb_build_object(
    'invoices', coalesce(
      (select jsonb_agg(to_jsonb(m) - 'invoice_day' order by m.id) from m where exists (select 1 from sel where sel.invoice_id = m.id)),
      '[]'::jsonb
    ),
    'lines', coalesce((select jsonb_agg(to_jsonb(l) order by l.id) from lines l), '[]'::jsonb),
    'truncated', (select n from skipped) > 0,
    'skipped_invoices', (select n from skipped)
  );
$$;

revoke execute on function public.bank_auto_match_input(uuid, numeric, integer, integer, integer, integer, uuid) from public, anon, authenticated;
grant execute on function public.bank_auto_match_input(uuid, numeric, integer, integer, integer, integer, uuid) to service_role;
