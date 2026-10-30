import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { runWorkerPass, workerConfig, WORKER_BUDGET_MS, WORKER_MAX_JOBS, type WorkerDeps } from '@/lib/processingWorker';
import { MIN_LLM_STEP_MS } from '@/shared/processing';
import type { TickResult } from '@/lib/processingQueue';

/** A fake clock that the fake drive advances, and a due list that shrinks as jobs finish. */
function setup(jobIds: string[], driveMs: number, finalState: TickResult['state'] = 'done') {
  let now = 1_000_000;
  const due = new Set(jobIds);
  const inFlight = new Set<string>();
  let maxParallel = 0;
  const drives: { id: string; deadline: number }[] = [];
  const deps: WorkerDeps = {
    now: () => now,
    sweep: async () => ({ failed: ['stuck1'], enqueued: ['new1', 'new2'] }),
    dueJobs: async (limit) => {
      const ids = [...due].filter((id) => !inFlight.has(id));
      return { ids: ids.slice(0, limit), total: ids.length };
    },
    drive: async (id, deadline) => {
      drives.push({ id, deadline });
      inFlight.add(id);
      maxParallel = Math.max(maxParallel, inFlight.size);
      await new Promise((resolve) => setTimeout(resolve, 1));
      now += driveMs;
      inFlight.delete(id);
      if (finalState === 'done') due.delete(id);
      return { state: finalState };
    },
  };
  return { deps, drives, maxParallel: () => maxParallel, due };
}

describe('runWorkerPass', () => {
  test('drives due jobs in parallel up to maxJobs and reports a summary', async () => {
    const s = setup(['a', 'b', 'c'], 100);
    const summary = await runWorkerPass(s.deps, { budgetMs: 20_000, maxJobs: 6 });
    assert.equal(summary.stuck, 1);
    assert.equal(summary.enqueued, 2);
    assert.deepEqual(summary.driven.map((d) => d.id).sort(), ['a', 'b', 'c']);
    assert.ok(summary.driven.every((d) => d.state === 'done'));
    assert.equal(summary.due, 0);
    assert.ok(summary.ms >= 0);
    assert.ok(s.drives.every((d) => d.deadline === 1_000_000 + 20_000));
  });

  test('never runs more than maxJobs at once and refills freed slots', async () => {
    const ids = Array.from({ length: 10 }, (_, i) => `j${i}`);
    const s = setup(ids, 10);
    const summary = await runWorkerPass(s.deps, { budgetMs: 20_000, maxJobs: 4 });
    assert.ok(s.maxParallel() <= 4, `parallel ${s.maxParallel()}`);
    assert.equal(summary.driven.length, 10);
    assert.equal(new Set(summary.driven.map((d) => d.id)).size, 10);
  });

  test('stops starting jobs when an LLM step no longer fits, and reports what is still due', async () => {
    const ids = Array.from({ length: 8 }, (_, i) => `j${i}`);
    // Every drive uses the time an LLM step needs: one round of 2 slots, then nothing fits
    const s = setup(ids, MIN_LLM_STEP_MS, 'pending');
    const summary = await runWorkerPass(s.deps, { budgetMs: 20_000, maxJobs: 2 });
    assert.equal(summary.driven.length, 2);
    assert.equal(summary.due, 8);
  });

  test('does not drive the same job twice in one pass', async () => {
    const s = setup(['a', 'b'], 10, 'pending');
    const summary = await runWorkerPass(s.deps, { budgetMs: 20_000, maxJobs: 3 });
    assert.deepEqual(summary.driven.map((d) => d.id).sort(), ['a', 'b']);
    assert.equal(summary.due, 2);
  });

  test('a failing sweep or drive does not stop the pass', async () => {
    const s = setup(['a', 'b'], 10);
    s.deps.sweep = async () => {
      throw new Error('db down');
    };
    const drive = s.deps.drive;
    s.deps.drive = async (id, deadline) => {
      if (id === 'a') throw new Error('boom');
      return drive(id, deadline);
    };
    const summary = await runWorkerPass(s.deps, { budgetMs: 20_000, maxJobs: 2 });
    assert.equal(summary.stuck, 0);
    assert.deepEqual(summary.driven.find((d) => d.id === 'a'), { id: 'a', state: 'error' });
    assert.deepEqual(summary.driven.find((d) => d.id === 'b'), { id: 'b', state: 'done' });
  });
});

describe('workerConfig', () => {
  test('defaults', () => {
    assert.deepEqual(workerConfig({}), { budgetMs: WORKER_BUDGET_MS, maxJobs: WORKER_MAX_JOBS });
    assert.deepEqual(workerConfig({ PROCESSING_WORKER_BUDGET_MS: '', PROCESSING_WORKER_MAX_JOBS: 'x' }), { budgetMs: WORKER_BUDGET_MS, maxJobs: WORKER_MAX_JOBS });
  });
  test('values are clamped so the answer leaves before the Amplify cut', () => {
    assert.deepEqual(workerConfig({ PROCESSING_WORKER_BUDGET_MS: '60000', PROCESSING_WORKER_MAX_JOBS: '100' }), { budgetMs: 24_000, maxJobs: 12 });
    assert.deepEqual(workerConfig({ PROCESSING_WORKER_BUDGET_MS: '15000', PROCESSING_WORKER_MAX_JOBS: '3' }), { budgetMs: 15_000, maxJobs: 3 });
  });
});
