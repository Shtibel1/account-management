-- QA round 3, processing pipeline on Amplify
--
-- Work left in next/server after() is frozen on Amplify (SSR compute = Lambda, no waitUntil) until a
-- later request thaws the instance: leases lapsed, steps were re-claimed and the sockets broken by the
-- freeze failed with 'fetch failed' / 'Connection error.', which used up the 3 attempts of a step and
-- ended runs as a generic error. All processing now runs inside requests (src/lib/processingQueue.ts),
-- and transient failures get a budget of their own, with backoff:
--
--   processing_jobs.transient_attempts - transient failures / interrupted ticks of the current step
--                                        without progress (MAX_TRANSIENT_ATTEMPTS = 6)
--   processing_jobs.retry_at           - backoff: no tick takes the job before this time
--   invoices.processing_error_detail   - the technical cause of the last failed run. The job row (and
--                                        its last_error) is deleted when a run fails, so the cause is
--                                        kept here; users see only the Hebrew error_message. Covered by
--                                        the invoices RLS policies (office members only).
--
-- Until this is applied the app keeps working: transient failures then count as real ones (3 attempts)
-- and the technical cause stays in the server log only.

alter table public.processing_jobs add column if not exists transient_attempts integer not null default 0;
alter table public.processing_jobs add column if not exists retry_at timestamptz;

comment on column public.processing_jobs.transient_attempts is
  'Transient failures (network, timeouts, 429/5xx, interrupted ticks) of the current step without progress (src/lib/processingQueue.ts).';
comment on column public.processing_jobs.retry_at is
  'Retry backoff after a transient failure: no tick takes the job before this time.';

alter table public.invoices add column if not exists processing_error_detail text;

comment on column public.invoices.processing_error_detail is
  'Technical cause of the last failed processing run (stage, attempts, error chain). Not shown as is; error_message holds the Hebrew text.';
