-- QA round 2, processing pipeline (findings #6, N2, N4, N5, N11, N14, N20, N22, N23)
--
-- Extraction of a long PDF used to be one LLM call of up to several minutes inside one tick, far
-- past the ~28 s Amplify response limit: the request got a 504, the 5-minute job lock sat dead when
-- the compute was killed, and the paid extraction ran again from the start. The queue now extracts
-- in resumable steps (one LLM call per tick, over a few pages: src/shared/extractionChunks.ts) and
-- stores each step's result here before the next one starts, so a killed tick re-pays only for its
-- own call. The job lease is short (45 s) and renewed by a heartbeat while a step runs.
--
-- Until this is applied the app keeps working: extraction then runs in one tick, as before.

alter table public.processing_jobs add column if not exists extract_state jsonb;

comment on column public.processing_jobs.extract_state is
  'Resumable extraction: page chunks, per-chunk results, few-shot lookup, math-retry phase (src/shared/extractionChunks.ts).';

-- The scheduled worker picks jobs with a free lease, oldest activity first.
create index if not exists processing_jobs_locked_idx on public.processing_jobs (locked_until, updated_at);
