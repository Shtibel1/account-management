import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FileMoveDb } from '@/lib/invoiceFiles';

process.env.SUPABASE_URL = 'https://proj.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://proj.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon';
const { relocateInvoiceFiles, removeUnusedOldFiles } = await import('@/lib/invoiceFiles');

const ref = (path: string) => `https://proj.supabase.co/storage/v1/object/authenticated/raw-invoices/${path}`;

function fakeDb(opts: { copyError?: string; inUse?: string[] } = {}) {
  const copies: [string, string][] = [];
  const removed: string[][] = [];
  const db: FileMoveDb = {
    rpc: async (_fn, args) => ({ data: (args.p_paths as string[]).filter((p) => (opts.inUse ?? []).includes(p)), error: null }),
    storage: {
      from: () => ({
        copy: async (from, to) => {
          copies.push([from, to]);
          return { error: opts.copyError ? { message: opts.copyError } : null };
        },
        remove: async (paths) => {
          removed.push(paths);
          return { error: null };
        },
      }),
    },
  };
  return { db, copies, removed };
}

describe('moving an invoice to another client moves its files (QA round 7)', () => {
  test('file and split original are copied to the new folder and the new references returned', async () => {
    const f = fakeDb();
    const r = await relocateInvoiceFiles(f.db, { client_id: 'c1', file_url: ref('c1/a.png'), original_file_url: ref('c1/orig.pdf') }, 'c2');
    assert.ok(r.ok);
    assert.deepEqual(f.copies, [['c1/a.png', 'c2/a.png'], ['c1/orig.pdf', 'c2/orig.pdf']]);
    assert.deepEqual(r.update, { file_url: ref('c2/a.png'), original_file_url: ref('c2/orig.pdf') });
    assert.deepEqual(r.oldPaths, ['c1/a.png', 'c1/orig.pdf']);
  });

  test('an original already copied by a sibling part is fine; other copy errors stop the move', async () => {
    const dup = await relocateInvoiceFiles(fakeDb({ copyError: 'The resource already exists' }).db, { client_id: 'c1', file_url: ref('c1/a.png') }, 'c2');
    assert.ok(dup.ok);
    const bad = await relocateInvoiceFiles(fakeDb({ copyError: 'denied' }).db, { client_id: 'c1', file_url: ref('c1/a.png') }, 'c2');
    assert.equal(bad.ok, false);
  });

  test('a file outside the client folder (untrusted URL) is left alone', async () => {
    const f = fakeDb();
    const r = await relocateInvoiceFiles(f.db, { client_id: 'c1', file_url: 'https://evil.example/x.png' }, 'c2');
    assert.ok(r.ok);
    assert.deepEqual(r.update, {});
    assert.deepEqual(f.copies, []);
  });

  test('old files still used by another invoice are kept', async () => {
    const f = fakeDb({ inUse: ['c1/orig.pdf'] });
    await removeUnusedOldFiles(f.db, ['c1/a.png', 'c1/orig.pdf']);
    assert.deepEqual(f.removed, [['c1/a.png']]);
  });
});
