-- QA round 3: bank import 504 (auto-match cost grew with the client's total line count).
--
-- runAutoMatch() (src/lib/bankTransactions.ts) used to load EVERY line of the client (select *) and
-- every matchable invoice (full validated_data / extracted_data), then send one UPDATE per match:
-- ~13 s at 110k lines, on top of the import, so the request ran into Amplify's ~28 s cut. Now:
-- 1. bank_auto_match_input(): one call returning only the unmatched debits whose amount is within
--    the tolerance of a free (not yet matched) approved/exported invoice and whose date is inside
--    that invoice's matching window (DAYS_BEFORE_INVOICE / DAYS_AFTER_INVOICE in bankMatch.ts) -
--    every line that can be matched, so also every rival of a match - plus those invoices with
--    just the fields matching needs. Driven by the invoices through a partial (client_id, amount)
--    index on unmatched debits, so its cost grows with the invoices, not with the total line
--    count, and old unmatched debits (fees, transfers) don't pile up in the candidate set.
-- 2. apply_bank_auto_matches(): stores a chunk of pairs in one call. A pair whose line was handled
--    meanwhile, or whose invoice was matched to another line in parallel (unique index) or is no
--    longer matchable (bank_transactions_check_match), is skipped instead of failing the chunk.
-- Both are service role only, like the import functions. Idempotent: safe to run more than once.
-- Neither sets its own statement_timeout (a function-level SET doesn't bound the RPC statement
-- that calls it): the PostgREST role timeout and the app's AbortSignal deadline bound them.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Candidate lines + free invoices for one auto-match run
-- ─────────────────────────────────────────────────────────────────────────────
create index if not exists bank_transactions_unmatched_debit_amount_idx
  on public.bank_transactions (client_id, amount)
  where match_status = 'unmatched' and amount < 0;

-- Returns {invoices: [...], lines: [...], truncated: bool}. Invoice fields as toMatchableInvoice()
-- reads them (validated_data, else extracted_data). p_tolerance should be a little above the app's
-- AMOUNT_TOLERANCE: the exact, rounded comparison runs in the app. A line is a candidate when
-- invoice_date - p_days_before <= txn_date <= invoice_date + p_days_after (the app's window, same
-- day arithmetic as dayNumber(): YYYY-MM-DD prefix, out-of-range day/month roll over like
-- Date.UTC; anything else -> no candidates, as the app can't date it either). More than
-- p_max_lines candidate lines -> truncated = true (the app then matches nothing, see runAutoMatch).
-- The 3-argument signature of an earlier draft of this migration is dropped so only this one exists.
drop function if exists public.bank_auto_match_input(uuid, numeric, integer);

create or replace function public.bank_auto_match_input(
  p_client_id uuid,
  p_tolerance numeric,
  p_max_lines integer,
  p_days_before integer,
  p_days_after integer
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
  cand as (
    select distinct t.id
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
  lines as (
    select t.id, t.txn_date, t.description, t.amount, t.rejected_invoice_ids, t.import_batch_id
    from cand
    join public.bank_transactions t on t.id = cand.id
    order by t.id
    limit greatest(p_max_lines, 0) + 1
  )
  select jsonb_build_object(
    'invoices', coalesce((select jsonb_agg(to_jsonb(m) - 'invoice_day') from m), '[]'::jsonb),
    'lines', coalesce(
      (select jsonb_agg(to_jsonb(l)) from (select * from lines order by id limit greatest(p_max_lines, 0)) l),
      '[]'::jsonb
    ),
    'truncated', (select count(*) from lines) > greatest(p_max_lines, 0)
  );
$$;

revoke execute on function public.bank_auto_match_input(uuid, numeric, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.bank_auto_match_input(uuid, numeric, integer, integer, integer) to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Store a chunk of auto-match pairs
-- ─────────────────────────────────────────────────────────────────────────────
-- p_matches: [{transaction_id, invoice_id}]. Only lines of p_client_id that are still unmatched
-- are touched (a reviewer may have acted on them meanwhile). Each pair runs in its own
-- subtransaction, so one conflicting pair doesn't undo the others. Returns the pairs stored.
create or replace function public.apply_bank_auto_matches(
  p_client_id uuid,
  p_matches jsonb
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  r record;
  v_matched integer := 0;
begin
  for r in
    select x.transaction_id, x.invoice_id
    from jsonb_to_recordset(coalesce(p_matches, '[]'::jsonb)) as x(transaction_id uuid, invoice_id uuid)
    where x.transaction_id is not null and x.invoice_id is not null
  loop
    begin
      update public.bank_transactions t
      set matched_invoice_id = r.invoice_id, match_status = 'auto'
      where t.id = r.transaction_id
        and t.client_id = p_client_id
        and t.match_status = 'unmatched';
      if found then
        v_matched := v_matched + 1;
      end if;
    exception
      -- unique_violation: the invoice was matched to another line in parallel;
      -- raise_exception (P0001): bank_match_invalid from bank_transactions_check_match()
      when unique_violation or raise_exception then
        null;
    end;
  end loop;
  return v_matched;
end;
$$;

revoke execute on function public.apply_bank_auto_matches(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.apply_bank_auto_matches(uuid, jsonb) to service_role;
