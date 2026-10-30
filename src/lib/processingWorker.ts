import type { DueJobs, SweepResult, TickResult } from '@/lib/processingQueue';
import { MIN_OCR_STEP_MS, TICK_HARD_LIMIT_MS } from '@/shared/processing';

/**
 * One pass of the scheduled processing worker (/api/invoices/worker), done INSIDE the request: on
 * Amplify nothing runs after a response (QA round 3), so the pass ends before its deadline and the
 * route answers with what it did. Pure orchestration over injected queue functions (testable).
 *
 * Sizing (QA round 3: 4+ unattended uploads, incl. 22- and 25-page PDFs, must all move every
 * minute): an AWS Lambda calls the worker every minute and again while `due` > 0 (Lambda timeout
 * 60 s, so ~2 passes a minute). Each pass has WORKER_BUDGET_MS = 23 s (Amplify cuts responses at
 * ~28 s; the answer leaves by WORKER_HARD_LIMIT_MS whatever happens) and drives up to
 * WORKER_MAX_JOBS = 6 jobs in parallel. An LLM step starts only with MIN_LLM_STEP_MS (18 s) left,
 * so each of 6 concurrent runs gets one LLM step (one extraction part / the boundary detection) with
 * a full ~20 s call per pass, or ~10 pages of OCR plus whatever else still fits: ~2 steps a minute
 * per run. A 25-page PDF needs ~3 OCR steps, 1 detection step and ~9 extraction parts: 5-8 minutes.
 * More parallel jobs would mostly add Vision / Anthropic rate-limit pressure (429s, retried with
 * backoff) and memory (each job holds its PDF of up to 20 MB). Both values can be set with
 * PROCESSING_WORKER_BUDGET_MS / PROCESSING_WORKER_MAX_JOBS.
 */

export const WORKER_BUDGET_MS = 23_000;
/** The budget never exceeds this: the response must leave before Amplify's ~28 s cut. */
export const WORKER_MAX_BUDGET_MS = 24_000;
export const WORKER_MAX_JOBS = 6;
/**
 * The pass answers by budget + this (at most TICK_HARD_LIMIT_MS) even if a step overran (a slow
 * download / save without its own limit): the overrunning step's lease then runs out and the next
 * pass redoes it as a transient interruption, instead of Amplify answering a bare 504.
 */
export const WORKER_HARD_LIMIT_SLACK_MS = 3_000;

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
  /** Resolves after `ms` (the hard limit's timer; injectable for tests). */
  wait?: (ms: number) => Promise<void>;
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
  /** Jobs whose step was still running at the hard limit (answered without them). */
  overran?: string[];
}

const defaultWait = (ms: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    (timer as { unref?: () => void }).unref?.();
  });

/**
 * Sweep (in parallel), and drive due jobs with up to `maxJobs` in parallel until the deadline. A slot
 * that frees up takes the next due job (not one driven in this pass already) while a step still
 * fits. Answers by the hard limit at the latest, with what was done by then.
 */
export async function runWorkerPass(deps: WorkerDeps, config: WorkerConfig): Promise<WorkerSummary> {
  const wait = deps.wait ?? defaultWait;
  const started = deps.now();
  const deadline = started + config.budgetMs;
  const hardLimitMs = Math.min(TICK_HARD_LIMIT_MS, config.budgetMs + WORKER_HARD_LIMIT_SLACK_MS);
  const driven: WorkerSummary['driven'] = [];
  const inFlight = new Set<string>();
  let stuck = 0;
  let enqueued = 0;

  // The sweep runs beside the slots, so its queries / enqueues don't shorten the first steps' windows
  const sweep = deps.sweep().then((swept) => {
    stuck = swept.failed.length;
    enqueued = swept.enqueued.length;
  }, (err) => {
    console.error('[Processing Worker] Sweep failed:', err);
  });

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
  // A slot takes a job while its shortest step (OCR) still fits; the tick itself starts an LLM step
  // only with MIN_LLM_STEP_MS left and defers it otherwise
  const fits = () => deadline - deps.now() >= MIN_OCR_STEP_MS;

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
      inFlight.add(id);
      try {
        const r = await deps.drive(id, deadline);
        driven.push({ id, state: r.state });
      } catch (err) {
        console.error(`[Processing Worker] Drive failed for invoice ${id}:`, err);
        driven.push({ id, state: 'error' });
      } finally {
        inFlight.delete(id);
      }
    }
  };
  const work = Promise.all([sweep, ...Array.from({ length: config.maxJobs }, slot)]).then(() => true);
  const finished = await Promise.race([work, wait(hardLimitMs - (deps.now() - started)).then(() => false)]);

  let overran: string[] | undefined;
  if (!finished) {
    overran = [...inFlight];
    console.warn(`[Processing Worker] Hard limit (${hardLimitMs} ms) reached; answering without ${overran.length} running step(s): ${overran.join(', ')}`);
  }
  const count = deps.dueJobs(0).then((r) => r.total, (err) => {
    console.error('[Processing Worker] Due count failed:', err);
    return 0;
  });
  // After the hard limit only a short wait for the count (the answer must leave); unknown -> call again
  const due = finished ? await count : (await Promise.race([count, wait(1_000).then(() => null)])) ?? 1;
  return { stuck, enqueued, driven: [...driven], due, ms: deps.now() - started, ...(overran ? { overran } : {}) };
}
