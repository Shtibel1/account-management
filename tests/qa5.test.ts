// QA round 5: foreign client ids answer 404 (#2), truncated PDFs are rejected (#3), the missing-invoices
// total is summed in agorot (#4), the too-many-attempts message suggests splitting only long documents (#5).
// #1 (storage policies) is SQL: supabase/migrations/20261031110000_qa5_storage_guard.sql.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  DAMAGED_PDF_MESSAGE,
  PDF_TRAILER_SCAN_BYTES,
  checkStoredBytes,
  hasPdfStructure,
  hasPdfTrailer,
} from '@/shared/uploadValidation';
import {
  LONG_DOCUMENT_PAGES,
  TOO_MANY_ATTEMPTS_LONG_MESSAGE,
  TOO_MANY_ATTEMPTS_MESSAGE,
  UserFacingError,
  isUnreadableFileError,
  toUserErrorMessage,
  tooManyAttemptsMessage,
} from '@/shared/processing';
import { missingInvoicesSheetRows } from '@/lib/exporters/missingInvoices';
import { requireClientAccess, setAuthDependenciesForTests, type AuthContext } from '@/lib/auth';

async function realPdf(pages: number): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage();
    for (let line = 0; line < 40; line++) page.drawText(`Invoice page ${i + 1} line ${line} ${'x'.repeat(40)}`, { x: 20, y: 800 - line * 18, size: 9, font });
  }
  return doc.save({ useObjectStreams: false });
}

describe('truncated PDFs (#3)', () => {
  test('a real PDF cut at 50-60% is rejected at upload with the damaged-file message', async () => {
    const bytes = await realPdf(22);
    assert.equal(hasPdfStructure(bytes), true);
    for (const share of [0.5, 0.55, 0.6, 0.9]) {
      const cut = bytes.subarray(0, Math.floor(bytes.byteLength * share));
      assert.equal(hasPdfTrailer(cut), false, `cut at ${share}`);
      assert.deepEqual(checkStoredBytes(cut), { ok: false, error: DAMAGED_PDF_MESSAGE });
    }
  });

  test('trailing whitespace / garbage within the last 2 KB and incremental updates still pass', async () => {
    const bytes = Buffer.from(await realPdf(2));
    const padded = Buffer.concat([bytes, Buffer.from('\r\n\n  \0\0\0'), Buffer.alloc(1500, 0x20)]);
    assert.equal(checkStoredBytes(padded).ok, true);
    const garbage = Buffer.concat([bytes, Buffer.from('\n<!-- appended by a mail gateway -->\n')]);
    assert.equal(checkStoredBytes(garbage).ok, true);
    // An incremental update appends objects, an xref section and a new trailer after the first %%EOF
    const update = Buffer.concat([bytes, Buffer.from('\n9 0 obj\n<< /Producer (x) >>\nendobj\nxref\n0 1\n0000000000 65535 f \ntrailer\n<< /Size 10 /Prev 0 >>\nstartxref\n12345\n%%EOF\n')]);
    assert.equal(checkStoredBytes(update).ok, true);
    // ...but a file cut inside the update (after the first %%EOF, more than 2 KB further on) is not
    const cutUpdate = Buffer.concat([bytes, Buffer.from('\n9 0 obj\n<< /Length 5000 >>\nstream\n'), Buffer.alloc(PDF_TRAILER_SCAN_BYTES + 10, 0x41)]);
    assert.equal(hasPdfTrailer(cutUpdate), false);
  });

  test('a trailer with only startxref (no %%EOF) is accepted, garbage longer than 2 KB is not', async () => {
    const bytes = Buffer.from(await realPdf(1));
    const text = bytes.toString('latin1');
    const noEof = Buffer.from(text.slice(0, text.lastIndexOf('%%EOF')), 'latin1');
    assert.equal(hasPdfTrailer(noEof), true);
    assert.equal(hasPdfTrailer(Buffer.concat([bytes, Buffer.alloc(PDF_TRAILER_SCAN_BYTES, 0x41)])), false);
  });

  test('the QA corpus files that exist on this machine keep their verdict', () => {
    const files: Array<[string, boolean]> = [
      ['../../_qa/data/QA-p4.pdf', true],
      ['../../_qa/data/QA-split-3docs.pdf', true],
      ['../../_qa/r5/core/files/QA-r5core-trunc50.pdf', false],
    ];
    for (const [rel, valid] of files) {
      let bytes: Buffer;
      try {
        bytes = readFileSync(fileURLToPath(new URL(rel, import.meta.url)));
      } catch {
        continue; // not on this machine (CI): the synthetic tests above cover it
      }
      assert.equal(checkStoredBytes(bytes).ok, valid, rel);
    }
  });

  test('a PDF Vision rejects after pdf-lib failed is "damaged", not "not a PDF"', () => {
    const visionErr = new Error('Google Cloud Vision error: Unsupported input file format. [3 INVALID_ARGUMENT]');
    assert.equal(isUnreadableFileError(visionErr), true);
    assert.equal(isUnreadableFileError(new Error('fetch failed: ECONNRESET')), false);
    assert.equal(isUnreadableFileError(new UserFacingError(DAMAGED_PDF_MESSAGE)), false);
    assert.equal(toUserErrorMessage(visionErr), 'הקובץ אינו PDF או תמונה תקינים - יש להעלות קובץ אחר');
  });
});

describe('missing-invoices total in agorot (#4)', () => {
  test('100k lines of 1.10 sum to exactly 110000', () => {
    const lines = Array.from({ length: 100_000 }, (_, i) => ({
      txn_date: '2026-10-01',
      account_label: 'עו"ש',
      description: `line ${i}`,
      reference: null,
      amount: -1.1,
    }));
    const rows = missingInvoicesSheetRows(lines);
    assert.equal(rows[rows.length - 1][4], 110000);
  });

  test('mixed amounts with float noise', () => {
    const amounts = [-0.1, -0.2, -19.99, -1234.56, -0.07];
    const rows = missingInvoicesSheetRows(amounts.map((amount, i) => ({ txn_date: '2026-10-01', account_label: 'a', description: `${i}`, reference: null, amount })));
    assert.equal(rows[rows.length - 1][4], 1254.92);
  });
});

describe('too-many-attempts message (#5)', () => {
  test('splitting is suggested only for a long document', () => {
    assert.equal(tooManyAttemptsMessage(1), TOO_MANY_ATTEMPTS_MESSAGE);
    assert.equal(tooManyAttemptsMessage(null), TOO_MANY_ATTEMPTS_MESSAGE);
    assert.equal(tooManyAttemptsMessage(LONG_DOCUMENT_PAGES), TOO_MANY_ATTEMPTS_LONG_MESSAGE);
    assert.doesNotMatch(TOO_MANY_ATTEMPTS_MESSAGE, /לפצל/);
    assert.match(TOO_MANY_ATTEMPTS_LONG_MESSAGE, /לפצל/);
  });
});

describe('client guard: another office\'s client looks like a missing one (#2)', () => {
  const OWN = '11111111-1111-4111-8111-111111111111';
  const FOREIGN = '22222222-2222-4222-8222-222222222222';
  const MISSING = '33333333-3333-4333-8333-333333333333';
  const clients: Record<string, string> = { [OWN]: 'org-a', [FOREIGN]: 'org-b' };

  function stubDb(): SupabaseClient {
    return {
      from(table: string) {
        let id = '';
        const q = {
          select: () => q,
          eq: (_col: string, v: string) => {
            id = v;
            return q;
          },
          order: async () => ({ data: [{ org_id: 'org-a', role: 'member' }], error: null }),
          maybeSingle: async () => ({ data: table === 'clients' && clients[id] ? { id, org_id: clients[id] } : null, error: null }),
        };
        return q;
      },
    } as unknown as SupabaseClient;
  }

  test('foreign and non-existent ids both answer 404 with the same body', async () => {
    setAuthDependenciesForTests({ db: stubDb() });
    const ctx = (): AuthContext => ({ user: { id: 'u1', email: null }, mock: false });
    const own = await requireClientAccess(OWN, ctx());
    assert.equal(own.ok, true);
    const foreign = await requireClientAccess(FOREIGN, ctx());
    const missing = await requireClientAccess(MISSING, ctx());
    assert.equal(foreign.ok, false);
    assert.equal(missing.ok, false);
    if (foreign.ok || missing.ok) return;
    assert.equal(foreign.response.status, 404);
    assert.equal(missing.response.status, 404);
    assert.deepEqual(await foreign.response.json(), await missing.response.json());
  });
});
