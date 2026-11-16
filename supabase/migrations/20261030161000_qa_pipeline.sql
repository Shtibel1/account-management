-- QA pipeline robustness (findings #6, #14, #17, #20, #21, #29, #44)
--
-- 1. Durable processing queue: /api/invoices/[id]/process only enqueues; the work runs in short,
--    resumable ticks (src/lib/processingQueue.ts) so no HTTP request has to outlive the Amplify
--    ~28 s response limit. processing_jobs holds the per-run state (OCR pages done so far, split
--    suggestion, lock); invoices carries the progress fields the UI shows.
-- 2. Run token (invoices.processing_run_id): every pipeline write is conditioned on it, so a run
--    that was superseded (re-process, manual split, sweeper) can no longer overwrite the row.
-- 3. Split lineage: the original multi-page file stays referenced by every part.
-- 4. raw-invoices bucket: 20 MB limit and allowed document types, enforced by Storage itself.
--
-- No invoice statuses are added (the queue reuses 'processing'), so the invoices status
-- constraint is not touched here.

-- ── invoices: progress + run token + split lineage ────────────────────────────
alter table public.invoices add column if not exists processing_run_id uuid;
alter table public.invoices add column if not exists processing_started_at timestamptz;
alter table public.invoices add column if not exists processing_attempts integer not null default 0;
alter table public.invoices add column if not exists processing_stage text;
alter table public.invoices add column if not exists processing_progress jsonb;

alter table public.invoices add column if not exists split_parent_id uuid references public.invoices(id) on delete set null;
alter table public.invoices add column if not exists original_file_url text;
alter table public.invoices add column if not exists original_file_name text;
alter table public.invoices add column if not exists original_file_hash text;
alter table public.invoices add column if not exists split_start_page integer;
alter table public.invoices add column if not exists split_end_page integer;

alter table public.invoices drop constraint if exists invoices_processing_stage_check;
alter table public.invoices add constraint invoices_processing_stage_check
  check (processing_stage is null or processing_stage in ('queued', 'ocr', 'detect', 'extract', 'splitting'));

create index if not exists invoices_processing_idx
  on public.invoices (processing_started_at)
  where status = 'processing';

create index if not exists invoices_split_parent_idx
  on public.invoices (split_parent_id)
  where split_parent_id is not null;

comment on column public.invoices.processing_run_id is 'Token of the current pipeline run; pipeline writes are conditioned on it (stale runs cannot overwrite).';
comment on column public.invoices.processing_progress is '{pages_done, pages_total} while status = processing.';
comment on column public.invoices.original_file_url is 'Split parts: signed URL of the original multi-page file (kept in storage).';

-- ── processing_jobs: one row per invoice being processed ──────────────────────
create table if not exists public.processing_jobs (
  invoice_id uuid primary key references public.invoices(id) on delete cascade,
  run_id uuid not null,
  client_id uuid not null,
  file_url text not null,
  mime_type text not null,
  stage text not null default 'ocr' check (stage in ('ocr', 'detect', 'extract')),
  page_count integer,
  pages_done integer not null default 0,
  page_texts jsonb not null default '[]'::jsonb,
  ocr_words jsonb not null default '[]'::jsonb,
  ocr_confidence double precision,
  detected_languages jsonb,
  ocr_op_count integer not null default 0,
  split_suggestion jsonb,
  split_detection_failed boolean not null default false,
  split_input_tokens integer not null default 0,
  split_output_tokens integer not null default 0,
  -- ticks that claimed the current stage without finishing it (killed / timed out)
  stage_attempts integer not null default 0,
  lock_version integer not null default 0,
  locked_until timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists processing_jobs_updated_idx on public.processing_jobs (updated_at);

-- Service-role only (the worker); browsers read progress from invoices.
alter table public.processing_jobs enable row level security;
revoke all on public.processing_jobs from anon, authenticated;

-- ── raw-invoices bucket limits (defensive: the bucket is created outside the repo) ──
update storage.buckets
   set file_size_limit = 20971520,
       allowed_mime_types = array['application/pdf', 'image/jpeg', 'image/png', 'image/webp']
 where id = 'raw-invoices';
