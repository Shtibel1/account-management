import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cleanClientName, DUPLICATE_CLIENT_NAME_MESSAGE, findDuplicateClientName, normalizeClientName } from '@/shared/clientName';
import { createClientRecord, updateClientRecord, type ClientRecordsDb, type ClientRow } from '@/lib/clientRecords';

const ORG_A = 'org-a';
const ORG_B = 'org-b';

function fakeDb(seed: ClientRow[], opts: { insertError?: { code?: string; message: string } } = {}) {
  const rows = seed.map((r) => ({ ...r }));
  const mappings: string[] = [];
  let n = 0;
  const db: ClientRecordsDb = {
    listClients: async (orgId) => ({ data: rows.filter((r) => !orgId || r.org_id === orgId).map(({ id, name }) => ({ id, name })), error: null }),
    insertClient: async (row) => {
      if (opts.insertError) return { data: null, error: opts.insertError };
      const created = { id: `new-${++n}`, name: row.name, vat_account: row.vat_account, org_id: row.org_id ?? null };
      rows.push(created);
      return { data: created, error: null };
    },
    insertDefaultMappings: async (clientId) => {
      mappings.push(clientId);
      return { error: null };
    },
    updateClient: async (id, patch) => {
      const row = rows.find((r) => r.id === id);
      if (!row) return { data: null, error: null };
      Object.assign(row, patch);
      return { data: { ...row }, error: null };
    },
  };
  return { db, rows, mappings };
}

describe('client names are unique per office (QA round 8)', () => {
  test('names compare trimmed, case-insensitively, with inner whitespace collapsed', () => {
    assert.equal(cleanClientName('  QA-דפדפן \t בע"מ  '), 'QA-דפדפן בע"מ');
    assert.equal(normalizeClientName(' Acme   LTD '), normalizeClientName('acme ltd'));
    const list = [{ id: '1', name: 'QA-דפדפן' }];
    assert.equal(findDuplicateClientName(list, '  qa-דפדפן ')?.id, '1');
    assert.equal(findDuplicateClientName(list, 'QA-דפדפן', '1'), null);
    assert.equal(findDuplicateClientName(list, 'QA-דפדפן 2'), null);
  });

  test('creating the same name again in the office answers 409 with the Hebrew message', async () => {
    const f = fakeDb([]);
    const first = await createClientRecord(f.db, { orgId: ORG_A, name: 'QA-דפדפן', vatAccount: '1310' });
    assert.ok(first.ok);
    assert.deepEqual(f.mappings, [first.client.id]);
    const second = await createClientRecord(f.db, { orgId: ORG_A, name: ' qa-דפדפן  ', vatAccount: '' });
    assert.deepEqual(second, { ok: false, status: 409, error: DUPLICATE_CLIENT_NAME_MESSAGE, field: 'name' });
    assert.equal(f.rows.length, 1);
  });

  test('a different name, or the same name in another office, is allowed', async () => {
    const f = fakeDb([{ id: 'a1', name: 'QA-דפדפן', vat_account: '', org_id: ORG_A }]);
    assert.ok((await createClientRecord(f.db, { orgId: ORG_A, name: 'QA-דפדפן 2', vatAccount: '' })).ok);
    assert.ok((await createClientRecord(f.db, { orgId: ORG_B, name: 'QA-דפדפן', vatAccount: '' })).ok);
  });

  test('empty names and bad VAT codes are refused with field errors', async () => {
    const f = fakeDb([]);
    assert.deepEqual(await createClientRecord(f.db, { orgId: ORG_A, name: '   ', vatAccount: '' }), { ok: false, status: 400, error: 'יש להזין שם לקוח', field: 'name' });
    const bad = await createClientRecord(f.db, { orgId: ORG_A, name: 'X', vatAccount: 'abc!@#' });
    assert.equal(bad.ok, false);
    assert.equal(!bad.ok && bad.field, 'vat_account');
  });

  test('the DB trigger (simultaneous create) is reported as the same 409', async () => {
    const f = fakeDb([], { insertError: { code: '23505', message: 'clients.name already exists in this office' } });
    const r = await createClientRecord(f.db, { orgId: ORG_A, name: 'X', vatAccount: '' });
    assert.deepEqual(r, { ok: false, status: 409, error: DUPLICATE_CLIENT_NAME_MESSAGE, field: 'name' });
  });

  test('renaming onto another client of the office is refused; renaming to a free name works', async () => {
    const f = fakeDb([
      { id: 'a1', name: 'Alpha', vat_account: '', org_id: ORG_A },
      { id: 'a2', name: 'Beta', vat_account: '', org_id: ORG_A },
      { id: 'b1', name: 'Gamma', vat_account: '', org_id: ORG_B },
    ]);
    assert.deepEqual(await updateClientRecord(f.db, { id: 'a2', orgId: ORG_A, name: ' ALPHA ' }), { ok: false, status: 409, error: DUPLICATE_CLIENT_NAME_MESSAGE, field: 'name' });
    const renamed = await updateClientRecord(f.db, { id: 'a2', orgId: ORG_A, name: 'Gamma', vatAccount: '1310' });
    assert.ok(renamed.ok);
    assert.equal(renamed.client.name, 'Gamma');
    assert.equal(renamed.client.vat_account, '1310');
  });

  test('an existing duplicate keeps its name while its VAT code is edited', async () => {
    const f = fakeDb([
      { id: 'd1', name: 'Dup', vat_account: '', org_id: ORG_A },
      { id: 'd2', name: 'Dup', vat_account: '', org_id: ORG_A },
    ]);
    const r = await updateClientRecord(f.db, { id: 'd2', orgId: ORG_A, name: 'Dup', vatAccount: '1320' });
    assert.ok(r.ok);
    assert.equal(r.client.vat_account, '1320');
  });

  test('the migration guards inserts and renames with the same normalization, not a unique index', () => {
    const sql = readFileSync(new URL('../supabase/migrations/20261031130000_qa8_unique_client_name.sql', import.meta.url), 'utf8');
    assert.match(sql, /before insert or update of name, org_id on public\.clients/);
    assert.match(sql, /errcode = '23505'/);
    assert.match(sql, /lower\(btrim\(regexp_replace\(normalize\(/);
    assert.doesNotMatch(sql, /create unique index/i);
  });
});
