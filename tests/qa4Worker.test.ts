// QA round 4 #6: a job in a short retry backoff is reported (soon / next_due_in_ms) and, when it
// becomes due within the budget, driven in the same worker pass.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { runWorkerPass, WORKER_MAX_WAIT_ROUNDS, type WorkerDeps } from '@/lib/processingWorker';

describe('runWorkerPass: jobs becoming due soon', () => {
  test('waits for a job in a 5 s backoff and drives it in the same pass', async () => {
    let now = 1_000_000;
    let readyAt = now + 5_000; // in backoff
    const waits: number[] = [];
    const drives: number[] = [];
    const deps: WorkerDeps = {
      now: () => now,
      sweep: async () => ({ failed: [], enqueued: [] }),
      dueJobs: async (limit) => {
        const due = now >= readyAt && readyAt !== Infinity;
        return due
          ? { ids: ['a'].slice(0, limit), total: 1, soon: 0, nextDueInMs: null }
          : { ids: [], total: 0, soon: readyAt === Infinity ? 0 : 1, nextDueInMs: readyAt === Infinity ? null : readyAt - now };
      },
      drive: async () => {
        drives.push(now);
        now += 1_000;
        readyAt = Infinity; // done
        return { state: 'done' };
      },
      wait: async (ms) => {
        // the hard-limit timer is long; only the backoff waits move the clock
        if (ms > 10_000) return new Promise<void>(() => {});
        waits.push(ms);
        now += ms;
      },
    };
    const summary = await runWorkerPass(deps, { budgetMs: 20_000, maxJobs: 2 });
    assert.deepEqual(waits, [5_000]);
    assert.equal(drives.length, 1);
    assert.deepEqual(summary.driven, [{ id: 'a', state: 'done' }]);
    assert.equal(summary.due, 0);
    assert.equal(summary.soon, 0);
    assert.equal(summary.next_due_in_ms, null);
  });

  test('a job due only after the budget is reported for the caller instead', async () => {
    let now = 1_000_000;
    const deps: WorkerDeps = {
      now: () => now,
      sweep: async () => ({ failed: [], enqueued: [] }),
      dueJobs: async () => ({ ids: [], total: 0, soon: 1, nextDueInMs: 15_000 }),
      drive: async () => ({ state: 'done' }),
      wait: async (ms) => {
        if (ms > 10_000) return new Promise<void>(() => {});
        now += ms;
      },
    };
    const summary = await runWorkerPass(deps, { budgetMs: 20_000, maxJobs: 2 });
    assert.deepEqual(summary.driven, []);
    assert.equal(summary.due, 0);
    assert.equal(summary.soon, 1);
    assert.equal(summary.next_due_in_ms, 15_000);
  });

  test('waits at most WORKER_MAX_WAIT_ROUNDS times', async () => {
    let now = 1_000_000;
    let waits = 0;
    const deps: WorkerDeps = {
      now: () => now,
      sweep: async () => ({ failed: [], enqueued: [] }),
      // always "due in 100 ms", never due: the pass must not spin forever
      dueJobs: async () => ({ ids: [], total: 0, soon: 1, nextDueInMs: 100 }),
      drive: async () => ({ state: 'done' }),
      wait: async (ms) => {
        if (ms > 10_000) return new Promise<void>(() => {});
        waits++;
        now += ms;
      },
    };
    await runWorkerPass(deps, { budgetMs: 20_000, maxJobs: 1 });
    assert.equal(waits, WORKER_MAX_WAIT_ROUNDS);
  });
});
