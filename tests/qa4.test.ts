// QA round 4: lost queue jobs, stuck-run messages, damaged PDFs, registrar availability, client deletion.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ENQUEUE_GRACE_MS,
  LONG_DOCUMENT_PAGES,
  LOST_JOB_MESSAGE,
  MAX_LOST_JOB_REQUEUES,
  STALE_PROCESSING_MS,
  STUCK_LONG_RUN_MESSAGE,
  STUCK_RUN_MESSAGE,
  UserFacingError,
  isPermanentError,
  orphanRunAction,
  stuckRunMessage,
} from '@/shared/processing';
import { DAMAGED_PDF_MESSAGE, checkStoredBytes, hasPdfStructure, readPdfPageCount } from '@/shared/uploadValidation';
import { lookupVatIdByName } from '@/utils/businessLookup';
import { CLIENT_DELETE_MESSAGES, deleteClientWithFiles, type ClientDeletionDb } from '@/lib/clientDeletion';

const now = Date.parse('2026-10-31T10:00:00.000Z');
const ago = (ms: number) => new Date(now - ms).toISOString();

describe('orphanRunAction: a queued run that lost its job (QA round 4 #3)', () => {
  const base = { now, startedAt: null, attempts: 1, processingStage: 'queued' };

  test('is queued again after the enqueue grace, not failed after 10 minutes', () => {
    assert.equal(orphanRunAction({ ...base, rowUpdatedAt: ago(ENQUEUE_GRACE_MS / 2) }), 'wait');
    assert.equal(orphanRunAction({ ...base, rowUpdatedAt: ago(ENQUEUE_GRACE_MS) }), 'requeue');
    assert.equal(orphanRunAction({ ...base, rowUpdatedAt: ago(STALE_PROCESSING_MS + 1) }), 'requeue');
  });

  test('is capped: after MAX_LOST_JOB_REQUEUES it fails', () => {
    assert.equal(orphanRunAction({ ...base, rowUpdatedAt: ago(ENQUEUE_GRACE_MS), requeues: MAX_LOST_JOB_REQUEUES - 1 }), 'requeue');
    assert.equal(orphanRunAction({ ...base, rowUpdatedAt: ago(ENQUEUE_GRACE_MS), requeues: MAX_LOST_JOB_REQUEUES }), 'fail');
  });

  test('a run that lost its job mid-way still fails only when stale', () => {
    assert.equal(orphanRunAction({ ...base, processingStage: 'extract', rowUpdatedAt: ago(ENQUEUE_GRACE_MS) }), 'wait');
    assert.equal(orphanRunAction({ ...base, processingStage: 'extract', rowUpdatedAt: ago(STALE_PROCESSING_MS + 1) }), 'fail');
  });
});

describe('stuckRunMessage (QA round 4 #5)', () => {
  test('suggests splitting only for a long document that ran out of time', () => {
    assert.equal(stuckRunMessage('too_long', LONG_DOCUMENT_PAGES), STUCK_LONG_RUN_MESSAGE);
    assert.equal(stuckRunMessage('too_long', 1), STUCK_RUN_MESSAGE);
    assert.equal(stuckRunMessage('too_long', null), STUCK_RUN_MESSAGE);
    assert.equal(stuckRunMessage('no_progress', 40), STUCK_RUN_MESSAGE);
    assert.equal(stuckRunMessage('lost_job', 40), LOST_JOB_MESSAGE);
    assert.doesNotMatch(STUCK_RUN_MESSAGE, /לפצל/);
    assert.doesNotMatch(LOST_JOB_MESSAGE, /לפצל/);
    assert.match(STUCK_LONG_RUN_MESSAGE, /לפצל/);
  });
});

describe('damaged PDFs (QA round 4 #4)', () => {
  const garbage = Buffer.concat([Buffer.from('%PDF-'), Buffer.from('x7#@!qz9&*()_+=-0987654321zz')]);

  test('a PDF header followed by garbage is rejected with the damaged-file message', () => {
    assert.equal(garbage.length, 33);
    assert.equal(hasPdfStructure(garbage), false);
    assert.deepEqual(checkStoredBytes(garbage), { ok: false, error: DAMAGED_PDF_MESSAGE });
  });

  test('a minimal real PDF passes', () => {
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n');
    assert.equal(hasPdfStructure(pdf), true);
    assert.deepEqual(checkStoredBytes(pdf), { ok: true, mimeType: 'application/pdf' });
    // "obj" inside a word is not an object
    assert.equal(hasPdfStructure(Buffer.from(`%PDF-x ${'objection '.repeat(10)}`)), false);
  });

  test('an unreadable page tree gives null instead of throwing', () => {
    assert.equal(readPdfPageCount({ getPageCount: () => 3 }), 3);
    assert.equal(readPdfPageCount({ getPageCount: () => { throw new TypeError("Cannot read properties of undefined (reading 'Pages')"); } }), null);
  });

  test('with pdf-lib: a real file passes, the garbage one loads but has no readable page tree', async () => {
    const { PDFDocument } = await import('pdf-lib');
    const doc = await PDFDocument.create();
    doc.addPage();
    doc.addPage();
    const bytes = await doc.save();
    assert.equal(hasPdfStructure(bytes), true);
    assert.equal(readPdfPageCount(await PDFDocument.load(bytes)), 2);

    let loaded: { getPageCount(): number } | null = null;
    try {
      loaded = await PDFDocument.load(garbage, { ignoreEncryption: true });
    } catch {
      loaded = null; // a pdf-lib version that throws on load is fine too (loadPdf -> null)
    }
    if (loaded) assert.equal(readPdfPageCount(loaded), null);
  });

  test('the damaged-file error is permanent (no retries) and shown as is', () => {
    assert.equal(isPermanentError(new UserFacingError(DAMAGED_PDF_MESSAGE)), true);
  });
});

describe('lookupVatIdByName (QA round 4 #7)', () => {
  const records = (rs: Record<string, unknown>[]) => new Response(JSON.stringify({ success: true, result: { records: rs } }), { status: 200 });
  const empty = () => records([]);

  test('every registrar answering without a match is no_match', async () => {
    const r = await lookupVatIdByName('אלקטרה מוצרי צריכה', { fetchImpl: async () => empty() });
    assert.deepEqual(r, { status: 'no_match', vatId: null });
  });

  test('a timeout is retried once; still failing it is unavailable, not no_match', async () => {
    let calls = 0;
    const r = await lookupVatIdByName('אלקטרה מוצרי צריכה', {
      fetchImpl: async (input) => {
        calls++;
        if (String(input).includes('f004176c')) throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
        return empty();
      },
    });
    assert.equal(r.status, 'unavailable');
    assert.equal(calls, 4); // 3 registrars + 1 retry of the one that timed out
  });

  test('a 5xx that recovers on the retry finds the business', async () => {
    const seen = new Map<string, number>();
    const r = await lookupVatIdByName('אלקטרה מוצרי צריכה', {
      fetchImpl: async (input) => {
        const url = String(input);
        const n = (seen.get(url) ?? 0) + 1;
        seen.set(url, n);
        if (url.includes('f004176c')) {
          return n === 1 ? new Response('busy', { status: 503 }) : records([{ 'שם חברה': 'אלקטרה מוצרי צריכה בע"מ', 'מספר חברה': 520039876 }]);
        }
        return empty();
      },
    });
    assert.equal(r.status, 'found');
    assert.equal(r.vatId, '520039876');
  });

  test('a 4xx is not retried; no budget left means no retry', async () => {
    let calls = 0;
    const r = await lookupVatIdByName('אלקטרה מוצרי צריכה', {
      fetchImpl: async () => {
        calls++;
        return new Response('bad', { status: 400 });
      },
    });
    assert.equal(r.status, 'unavailable');
    assert.equal(calls, 3);

    let t = 0;
    calls = 0;
    const late = await lookupVatIdByName('אלקטרה מוצרי צריכה', {
      now: () => t,
      budgetMs: 6000,
      fetchImpl: async () => {
        calls++;
        t += 5500; // the first tries used up the budget
        throw new TypeError('fetch failed');
      },
    });
    assert.equal(late.status, 'unavailable');
    assert.equal(calls, 3);
  });

  test('a generic name is never looked up', async () => {
    const r = await lookupVatIdByName('ספקים שונים', { fetchImpl: async () => { throw new Error('must not be called'); } });
    assert.deepEqual(r, { status: 'skipped', vatId: null });
  });
});

describe('deleteClientWithFiles (QA round 4 #1)', () => {
  function fakeDb(answer: unknown, files: string[], opts: { removeFails?: boolean } = {}) {
    const removed: string[][] = [];
    const rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];
    const db: ClientDeletionDb = {
      rpc: async (fn, args) => {
        rpcCalls.push({ fn, args });
        return { data: answer, error: null };
      },
      storage: {
        from: () => ({
          list: async (_prefix, { limit, offset }) => ({ data: files.slice(offset, offset + limit).map((name) => ({ name, id: `id-${name}` })), error: null }),
          remove: async (paths) => {
            removed.push(paths);
            return { error: opts.removeFails ? { message: 'denied' } : null };
          },
        }),
      },
    };
    return { db, removed, rpcCalls };
  }

  test('a blocked client is not deleted and its files stay', async () => {
    const f = fakeDb('exported', ['a.pdf']);
    const r = await deleteClientWithFiles(f.db, 'raw-invoices', 'c1');
    assert.deepEqual(r, { ok: false, blocker: 'exported' });
    assert.deepEqual(f.removed, []);
    assert.ok(CLIENT_DELETE_MESSAGES.exported.length > 0);
  });

  test('imported bank transactions block the deletion with their own message (review)', async () => {
    const f = fakeDb('bank_transactions', ['a.pdf']);
    const r = await deleteClientWithFiles(f.db, 'raw-invoices', 'c1');
    assert.deepEqual(r, { ok: false, blocker: 'bank_transactions' });
    assert.deepEqual(f.removed, []);
    assert.match(CLIENT_DELETE_MESSAGES.bank_transactions, /תנועות בנק/);
  });

  test('a deleted client has its stored files removed in chunks', async () => {
    const files = Array.from({ length: 250 }, (_, i) => `f${i}.pdf`);
    const f = fakeDb('deleted', files);
    const r = await deleteClientWithFiles(f.db, 'raw-invoices', 'c1');
    assert.deepEqual(r, { ok: true, filesRemoved: 250, filesFailed: 0 });
    assert.deepEqual(f.rpcCalls, [{ fn: 'delete_client_guarded', args: { p_client_id: 'c1' } }]);
    assert.deepEqual(f.removed.map((c) => c.length), [100, 100, 50]);
    assert.equal(f.removed[0][0], 'c1/f0.pdf');
  });

  test('a failing file removal does not undo the deletion', async () => {
    const f = fakeDb('deleted', ['a.pdf'], { removeFails: true });
    const r = await deleteClientWithFiles(f.db, 'raw-invoices', 'c1');
    assert.deepEqual(r, { ok: true, filesRemoved: 0, filesFailed: 1 });
  });
});
