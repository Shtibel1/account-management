-- QA fixes (data-bank cluster): findings #4, #22, #23, #36, #39, #46 of the 2026-10-30 QA round.
--
-- 1. supplier_automation / invoice_corrections / bank_transactions: members can READ their own
--    office's rows, writes go through the server (service role) only. The server enforces the
--    auto-approve eligibility (5 clean human reviews), the correction log that eligibility is
--    computed from, and the bank matching rules (debit lines only, approved invoice of the same
--    client, amount tolerance). Before this, any member could POST supplier_automation
--    {auto_approve:true} or DELETE invoice_corrections through PostgREST and skip those checks.
-- 2. import_bank_transactions(): one statement = one transaction, so an import is all or nothing.
-- 3. A matched invoice that moves to another client or leaves approved/exported releases its bank
--    line (trigger on invoices; safety net for every write path, incl. the pipeline and REST).
-- 4. supplier_accuracy: invoices without a supplier VAT ID are no longer lumped into one '' row
--    under an arbitrary max(supplier_name); VAT IDs are normalized (8 digits -> 9).
-- Idempotent: safe to run more than once.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Server-only writes
-- ─────────────────────────────────────────────────────────────────────────────

revoke insert, update, delete on public.supplier_automation from authenticated;
revoke insert, update, delete on public.invoice_corrections from authenticated;
revoke insert, update, delete on public.bank_transactions from authenticated;
grant select on public.supplier_automation, public.invoice_corrections, public.bank_transactions to authenticated;

drop policy if exists supplier_automation_member_all on public.supplier_automation;
drop policy if exists supplier_automation_member_select on public.supplier_automation;
create policy supplier_automation_member_select on public.supplier_automation
  for select to authenticated
  using (client_id in (select public.accessible_client_ids()));

drop policy if exists invoice_corrections_member_all on public.invoice_corrections;
drop policy if exists invoice_corrections_member_select on public.invoice_corrections;
create policy invoice_corrections_member_select on public.invoice_corrections
  for select to authenticated
  using (exists (
    select 1 from public.invoices i
    where i.id = invoice_id and i.client_id in (select public.accessible_client_ids())
  ));

drop policy if exists bank_transactions_member_all on public.bank_transactions;
drop policy if exists bank_transactions_member_select on public.bank_transactions;
create policy bank_transactions_member_select on public.bank_transactions
  for select to authenticated
  using (client_id in (select public.accessible_client_ids()));

-- Defense in depth: even if a write grant comes back, only the server may turn auto-approve on.
create or replace function public.supplier_automation_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.auto_approve
     and (tg_op = 'INSERT' or not coalesce(old.auto_approve, false))
     and current_user in ('authenticated', 'anon') then
    raise exception 'auto_approve can only be enabled by the server after the eligibility check'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists supplier_automation_guard on public.supplier_automation;
create trigger supplier_automation_guard
  before insert or update on public.supplier_automation
  for each row execute function public.supplier_automation_guard();

-- Opt-ins that were written directly (never through the eligibility check, so enabled_at is null)
-- are switched off. The app also ignores them (isAutoApproveEnabled requires enabled_at).
update public.supplier_automation
set auto_approve = false, disabled_at = now(), disabled_reason = 'manual', updated_at = now()
where auto_approve and enabled_at is null;

-- Correction rows written with the leading zero dropped ('67929117' for '067929117').
update public.invoice_corrections
set supplier_vat_id = '0' || supplier_vat_id
where supplier_vat_id ~ '^\d{8}$';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Atomic statement import
-- ─────────────────────────────────────────────────────────────────────────────
-- p_rows: [{txn_date, description, amount, reference, dedupe_key}]. Lines already imported (same
-- client + account label + dedupe key) are skipped. Any bad value fails the whole call, so nothing
-- is stored. Returns the number of inserted lines.
create or replace function public.import_bank_transactions(
  p_client_id uuid,
  p_account_label text,
  p_batch_id uuid,
  p_source_file text,
  p_rows jsonb
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  inserted integer;
begin
  insert into public.bank_transactions (
    client_id, account_label, txn_date, description, amount, reference,
    matched_invoice_id, match_status, rejected_invoice_ids, dedupe_key, import_batch_id, source_file
  )
  select
    p_client_id, p_account_label, r.txn_date, coalesce(r.description, ''), r.amount, r.reference,
    null, 'unmatched', '{}', r.dedupe_key, p_batch_id, p_source_file
  from jsonb_to_recordset(p_rows) as r(txn_date date, description text, amount numeric, reference text, dedupe_key text)
  on conflict (client_id, account_label, dedupe_key) do nothing;
  get diagnostics inserted = row_count;
  return inserted;
end;
$$;

revoke execute on function public.import_bank_transactions(uuid, text, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.import_bank_transactions(uuid, text, uuid, text, jsonb) to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Release bank matches of an invoice that is no longer a valid match
-- ─────────────────────────────────────────────────────────────────────────────
-- Matching needs an approved/exported invoice of the line's own client. When an invoice moves to
-- another client, or leaves approved/exported (reopened for review, rejected, returned...), its
-- line goes back to unmatched so it shows up again in the missing-invoices list. Not added to
-- rejected_invoice_ids: once the invoice is approved again, auto-match may propose it again.
-- security definer: members may update invoices but have no write access to bank_transactions.
create or replace function public.invoices_release_bank_matches()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.client_id is distinct from old.client_id
     or (new.status is distinct from old.status and new.status not in ('approved', 'exported')) then
    update public.bank_transactions
    set matched_invoice_id = null, match_status = 'unmatched'
    where matched_invoice_id = new.id;
  end if;
  return null;
end;
$$;

revoke execute on function public.invoices_release_bank_matches() from public, anon, authenticated;

drop trigger if exists invoices_release_bank_matches on public.invoices;
create trigger invoices_release_bank_matches
  after update of status, client_id on public.invoices
  for each row execute function public.invoices_release_bank_matches();

-- Clean up matches that are already inconsistent.
update public.bank_transactions t
set matched_invoice_id = null, match_status = 'unmatched'
from public.invoices i
where i.id = t.matched_invoice_id
  and (i.client_id is distinct from t.client_id or i.status not in ('approved', 'exported'));

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. supplier_accuracy: no '' bucket, normalized VAT IDs
-- ─────────────────────────────────────────────────────────────────────────────
-- Invoices with a VAT ID: one row per (normalized) VAT ID, as before.
-- Invoices without one: one row per supplier name, supplier_vat_id null, vat_id_missing = true.
drop view if exists public.supplier_accuracy;
create view public.supplier_accuracy with (security_invoker = true) as
with reviewed as (
  select
    nullif(regexp_replace(coalesce(i.validated_data->>'supplier_vat_id', ''), '\D', '', 'g'), '') as vat_digits,
    nullif(btrim(i.validated_data->>'supplier_name'), '') as supplier_name,
    (select count(*) from public.invoice_corrections c where c.invoice_id = i.id) as corrections
  from public.invoices i
  where i.reviewed_at is not null
),
keyed as (
  select
    case when length(vat_digits) = 8 then '0' || vat_digits else vat_digits end as supplier_vat_id,
    supplier_name,
    corrections
  from reviewed
)
select
  supplier_vat_id,
  case when supplier_vat_id is null then coalesce(max(supplier_name), 'ספק לא מזוהה') else max(supplier_name) end as supplier_name,
  count(*) as reviewed_invoices,
  count(*) filter (where corrections > 0) as invoices_corrected,
  sum(corrections) as field_corrections,
  round(1 - (count(*) filter (where corrections > 0))::numeric / count(*), 4) as invoice_accuracy,
  (supplier_vat_id is null) as vat_id_missing
from keyed
group by supplier_vat_id, (case when supplier_vat_id is null then supplier_name end)
order by reviewed_invoices desc;

revoke all on public.supplier_accuracy from anon;
grant select on public.supplier_accuracy to authenticated, service_role;
