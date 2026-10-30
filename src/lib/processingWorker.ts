import type { DueJobs, SweepResult, TickResult } from '@/lib/processingQueue';
import { MIN_LLM_STEP_MS } from '@/shared/processing';

/**
 * One pass of the scheduled processing worker (/api/invoices/worker), done INSIDE the request: on
 * Amplify nothing runs after a response (QA round 3), so the pass ends before its deadline and the
 * route answers with what it did. Pure orchestration over injected queue functions (testable).
 *
 * Sizing (QA round 3: 4+ unattended uploads, incl. 22- and 25-page PDFs, must all move every
 * minute): an AWS Lambda calls the worker every minute and again while `due` > 0 (Lambda timeout
 * 60 s, so ~2-3 passes a minute). Each pass has WORKER_BUDGET_MS = 20 s (Amplify cuts responses at
 * ~28 s) and drives up to WORKER_MAX_JOBS = 6 jobs in parallel: every one of 6 concurrent runs gets
 * a step (~10 pages of OCR, or one extraction part) per pass, i.e. 2-3 steps a minute, and a job
 * that ends early frees its slot for the next due one while a step still fits. A 25-page PDF needs
 * ~3 OCR steps, 1 detection step and ~9 extraction parts: a few minutes. More parallel jobs would
 * mostly add Vision / Anthropic rate-limit pressure (429s, retried with backoff) and memory (each job
 * holds its PDF of up to 20 MB). Both values can be set with PROCESSING_WORKER_BUDGET_MS /
 * PROCESSING_WORKER_MAX_JOBS.
 */

export const WORKER_BUDGET_MS = 20_000;
/** The budget never exceeds this: the response must leave before Amplify's ~28 s cut. */
export const WORKER_MAX_BUDGET_MS = 24_000;
export const WORKER_MAX_JOBS = 6;

export interface WorkerConfig {
  budgetMs: number;
  maxJobs: number;
}

function intEnv(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = value === undefined || value.trim() === '' ? NaN : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export function workerConfig(env: Record<string, string | undefined> = process.env): WorkerConfig {
  return {
    budgetMs: intEnv(env.PROCESSING_WORKER_BUDGET_MS, WORKER_BUDGET_MS, 5_000, WORKER_MAX_BUDGET_MS),
    maxJobs: intEnv(env.PROCESSING_WORKER_MAX_JOBS, WORKER_MAX_JOBS, 1, 12),
  };
}

export interface WorkerDeps {
  now: () => number;
  sweep: () => Promise<SweepResult>;
  dueJobs: (limit: number) => Promise<DueJobs>;
  /** Drives one job until its run ends / its next step doesn't fit / the deadline (epoch ms). */
  drive: (invoiceId: string, deadline: number) => Promise<TickResult>;
}

export interface WorkerSummary {
  /** 'processing' rows the sweep marked as error. */
  stuck: number;
  /** Never-queued 'processing' rows the sweep queued. */
  enqueued: number;
  driven: { id: string; state: TickResult['state'] | 'error' }[];
  /** Jobs still due after this pass (the caller calls again while > 0). */
  due: number;
  ms: number;
}

/**
 * Sweep, then drive due jobs with up to `maxJobs` in parallel until the deadline. A slot that frees
 * up takes the next due job (not one driven in this pass already) while a step still fits.
 */
export async function runWorkerPass(deps: WorkerDeps, config: WorkerConfig): Promise<WorkerSummary> {
  const started = deps.now();
  const deadline = started + config.budgetMs;
  const driven: WorkerSummary['driven'] = [];
  let stuck = 0;
  let enqueued = 0;

  try {
    const swept = await deps.sweep();
    stuck = swept.failed.length;
    enqueued = swept.enqueued.length;
  } catch (err) {
    console.error('[Processing Worker] Sweep failed:', err);
  }

  const seen = new Set<string>();
  const queue: string[] = [];
  let exhausted = false;
  let refill: Promise<void> | null = null;
  /** The next due job not driven in this pass yet (one shared refill from the DB when the list runs out). */
  const nextId = async (): Promise<string | null> => {
    for (;;) {
      const id = queue.shift();
      if (id !== undefined) {
        if (seen.has(id)) continue;
        seen.add(id);
        return id;
      }
      if (exhausted) return null;
      refill ??= (async () => {
        const due = await deps.dueJobs(config.maxJobs + seen.size);
        const fresh = due.ids.filter((x) => !seen.has(x) && !queue.includes(x));
        if (fresh.length === 0) exhausted = true;
        queue.push(...fresh);
      })().finally(() => {
        refill = null;
      });
      await refill;
    }
  };
  // A slot starts a job only while an LLM step still fits (an OCR / finalize step is shorter)
  const fits = () => deadline - deps.now() >= MIN_LLM_STEP_MS;

  const slot = async () => {
    while (fits()) {
      let id: string | null;
      try {
        id = await nextId();
      } catch (err) {
        console.error('[Processing Worker] Due jobs lookup failed:', err);
        exhausted = true;
        return;
      }
      if (!id) return;
      try {
        const r = await deps.drive(id, deadline);
        driven.push({ id, state: r.state });
      } catch (err) {
        console.error(`[Processing Worker] Drive failed for invoice ${id}:`, err);
        driven.push({ id, state: 'error' });
      }
    }
  };
  await Promise.all(Array.from({ length: config.maxJobs }, slot));

  let due = 0;
  try {
    due = (await deps.dueJobs(0)).total;
  } catch (err) {
    console.error('[Processing Worker] Due count failed:', err);
  }
  return { stuck, enqueued, driven, due, ms: deps.now() - started };
}
