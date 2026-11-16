import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AccountMapping, Invoice } from '@/shared/types';
import { MoveinExporter, MOVEIN_LINE_LENGTH, moveinBankDetails, moveinText, validateMoveinInvoice } from '@/lib/exporters/movein';
import { alreadyExportedLines, LEGACY_SKIP_MESSAGES } from '@/lib/exporters/moveinClaim';
import { inDateRange } from '@/shared/invoiceDateRange';

// QA round "MOVEIN" (QA-MV-*): fixed-width Move-in file built from approved invoices.

function invoice(id: string, data: Record<string, unknown>): Invoice {
  return {
    id,
    client_id: 'c1',
    status: 'approved',
    file_name: `${id}.png`,
    validated_data: {
      supplier_name: 'ספק',
      supplier_vat_id: '512345679',
      invoice_number: '1001',
      invoice_date: '2026-10-01',
      amount_before_vat: 100,
      vat_amount: 18,
      total_amount: 118,
      expense_category: null,
      allocation_number: null,
      bank_name: null,
      bank_branch_code: null,
      bank_branch_name: null,
      bank_account: null,
      ...data,
    },
    extracted_data: null,
  } as unknown as Invoice;
}

const mappings: AccountMapping[] = [];

function lines(buf: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < buf.length - 1; i++) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a) {
      out.push(buf.subarray(start, i));
      start = i + 2;
      i++;
    }
  }
  assert.equal(start, buf.length, 'file ends with CRLF');
  return out;
}

describe('Move-in: control characters never break the record (QA-MV B1)', () => {
  test('CR / LF / TAB in the supplier name, invoice number and bank details', () => {
    const buf = new MoveinExporter().export(
      [
        invoice('a', { supplier_name: 'ספק\r\nשורה שנייה\tטאב', invoice_number: '10\t08', bank_name: 'בנק\nלאומי', bank_account: '123\r45' }),
        invoice('b', { supplier_name: 'ספק רגיל‏' }),
      ],
      mappings,
      '1310'
    );
    const recs = lines(buf);
    assert.equal(recs.length, 2, 'one physical line per invoice');
    for (const r of recs) {
      assert.equal(r.length, MOVEIN_LINE_LENGTH);
      assert.ok(!r.some((b) => b < 0x20), 'no control bytes inside a record');
      assert.ok(!r.includes(0x3f), 'no "?" from invisible marks');
    }
    // invoice number "10 08" (tab -> space) right-aligned in its 9-character field
    assert.equal(recs[0].subarray(3, 12).toString('latin1'), '    10 08');
  });

  test('moveinText cleans, keeps visible text', () => {
    assert.equal(moveinText('  א\r\n\tב  '), 'א ב');
    assert.equal(moveinText('בע"מ, ש\'ם'), 'בע"מ, ש\'ם');
    assert.equal(moveinText('תל־אביב'), 'תל-אביב');
    assert.equal(moveinText('שָׁלוֹם'), 'שלום');
    assert.equal(moveinText(null), '');
  });

  test('the invoice number is measured after cleaning (validation and file agree)', () => {
    assert.deepEqual(validateMoveinInvoice(invoice('a', { invoice_number: '12\t34' }), mappings, '1310'), []);
    assert.equal(validateMoveinInvoice(invoice('a', { invoice_number: '123\t456\t78' }), mappings, '1310').length, 1);
  });
});

describe('Move-in: bank details keep the account number (QA-MV B2)', () => {
  test('long names are dropped before the branch code / account are cut', () => {
    const text = moveinBankDetails({ bank_name: 'בנק לאומי', bank_branch_name: 'סניף "הדר" המרכזי', bank_branch_code: '800', bank_account: '12345/67' });
    assert.ok(text.length <= 50, text);
    assert.ok(text.endsWith('מספר חשבון : 12345/67'), text);
    assert.ok(text.includes("מס' סניף : 800"), text);
  });

  test('short details are unchanged', () => {
    assert.equal(moveinBankDetails({ bank_name: 'לאומי', bank_branch_code: '800', bank_account: '123' }), "לאומי מס' סניף : 800 מספר חשבון : 123");
    assert.equal(moveinBankDetails({}), '');
  });

  test('in the file the account number survives', () => {
    const buf = new MoveinExporter().export(
      [invoice('a', { bank_name: 'בנק לאומי לישראל בע"מ', bank_branch_name: 'סניף "הדר" המרכזי', bank_branch_code: '800', bank_account: '12345/67' })],
      mappings,
      '1310'
    );
    const rec = lines(buf)[0];
    assert.equal(rec.length, MOVEIN_LINE_LENGTH);
    assert.ok(rec.subarray(282).toString('latin1').includes('12345/67'));
  });
});

describe('Move-in: file layout for the QA-MV invoice set', () => {
  const set = [
    invoice('regular', {}),
    invoice('credit', { invoice_number: '1002', amount_before_vat: -100, vat_amount: -18, total_amount: -118 }),
    invoice('novat', { invoice_number: '1003', amount_before_vat: 250, vat_amount: 0, total_amount: 250 }),
    invoice('agorot', { invoice_number: '1006', amount_before_vat: 123.45, vat_amount: 22.22, total_amount: 145.67 }),
    invoice('longname', { invoice_number: '1005', supplier_name: 'QA-MV ש.מ. אחזקות ובניה בע"מ, סניף צפון - מחלקת "רכש" וה\'תשלומים\' הארוכה מאוד מאוד' }),
    invoice('mapped', { invoice_number: '1007', supplier_name: 'ספק ממופה' }),
  ];
  const maps = [{ mapping_type: 'supplier', key: 'ספק ממופה', account_code: '60010' }] as AccountMapping[];
  const recs = lines(new MoveinExporter().export(set, maps, '1310'));
  const field = (r: Buffer, start: number, len: number) => r.subarray(start, start + len).toString('latin1').trim();

  test('one 332-byte line per invoice, Windows-1255 Hebrew, no BOM', () => {
    assert.equal(recs.length, set.length);
    for (const r of recs) assert.equal(r.length, MOVEIN_LINE_LENGTH);
    assert.deepEqual([...recs[0].subarray(0, 3)], [0x20, 0xec, 0xe7]); // " לח" in Windows-1255
  });

  test('dates DD/MM/YYYY, amounts to the agora, credit notes negative', () => {
    assert.equal(field(recs[0], 21, 10), '01/10/2026');
    assert.equal(field(recs[0], 186, 12), '118.00');
    assert.equal(field(recs[1], 186, 12), '-118.00');
    assert.equal(field(recs[1], 222, 12), '-18.00');
    assert.equal(field(recs[2], 222, 12), '0.00');
    assert.equal(field(recs[3], 186, 12), '145.67');
    assert.equal(field(recs[3], 210, 12), '123.45');
    assert.equal(field(recs[3], 222, 12), '22.22');
  });

  test('mapped supplier gets its code, unmapped falls back to 3499', () => {
    assert.equal(field(recs[0], 41, 15), '3499');
    assert.equal(field(recs[5], 41, 15), '60010');
  });

  test('a long name with quotes / comma is cut to 50 without shifting the next field', () => {
    assert.equal(field(recs[4], 126, 15), '512345679');
  });
});

describe('Move-in download: already exported invoices are reported (QA-MV B3)', () => {
  test('lines name the invoice and point to the re-download path', () => {
    const r = alreadyExportedLines([invoice('x', { invoice_number: '1001' })]);
    assert.deepEqual(r.ids, ['x']);
    assert.equal(r.lines[0], `1001: ${LEGACY_SKIP_MESSAGES.already_exported}`);
  });
});

describe('review table: invoice-date range (QA-MV B4)', () => {
  const inv = (d: string | null) => invoice('d', { invoice_date: d });
  test('inclusive bounds, open ends, invoices without a date only without a range', () => {
    assert.equal(inDateRange(inv('2026-10-01'), '2026-10-01', '2026-10-31'), true);
    assert.equal(inDateRange(inv('2026-10-31'), '2026-10-01', '2026-10-31'), true);
    assert.equal(inDateRange(inv('2026-09-30'), '2026-10-01', '2026-10-31'), false);
    assert.equal(inDateRange(inv('2026-11-01'), '2026-10-01', ''), true);
    assert.equal(inDateRange(inv('2026-08-31'), '', '2026-09-01'), true);
    assert.equal(inDateRange(inv(null), '2026-10-01', ''), false);
    assert.equal(inDateRange(inv(null), '', ''), true);
  });
});
