// In-memory stand-in for the parts of the Supabase client the processing queue uses (tests only):
// from(table).select / insert / update / delete with eq / is / not / lt / in / order / limit /
// single, awaited as { data, error }. `missingColumns` simulates a migration that isn't applied.
import type { SupabaseClient } from '@supabase/supabase-js';

type Row = Record<string, unknown>;
type Filter = (row: Row) => boolean;

export interface FakeDb {
  client: SupabaseClient;
  tables: Record<string, Row[]>;
}

class Query implements PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }> {
  private filters: Filter[] = [];
  private op: 'select' | 'insert' | 'update' | 'delete' = 'select';
  private payload: Row | null = null;
  private returning = false;
  private selectCols = '*';
  private isSingle = false;
  private max: number | null = null;
  private orderBy: { col: string; asc: boolean } | null = null;

  constructor(private db: FakeDb, private table: string, private missing: Set<string>) {}

  select(cols = '*') {
    if (this.op === 'select') this.selectCols = cols;
    else this.returning = true;
    return this;
  }
  insert(row: Row) {
    this.op = 'insert';
    this.payload = row;
    return this;
  }
  update(patch: Row) {
    this.op = 'update';
    this.payload = patch;
    return this;
  }
  delete() {
    this.op = 'delete';
    return this;
  }
  eq(col: string, val: unknown) {
    this.filters.push((r) => r[col] === val);
    return this;
  }
  is(col: string, val: unknown) {
    this.filters.push((r) => (val === null ? r[col] === null || r[col] === undefined : r[col] === val));
    return this;
  }
  not(col: string, op: string, val: unknown) {
    this.filters.push((r) => (op === 'is' && val === null ? r[col] !== null && r[col] !== undefined : r[col] !== val));
    return this;
  }
  lt(col: string, val: string) {
    this.filters.push((r) => typeof r[col] === 'string' && (r[col] as string) < val);
    return this;
  }
  in(col: string, vals: unknown[]) {
    this.filters.push((r) => vals.includes(r[col]));
    return this;
  }
  order(col: string, opts: { ascending?: boolean } = {}) {
    this.orderBy = { col, asc: opts.ascending !== false };
    return this;
  }
  limit(n: number) {
    this.max = n;
    return this;
  }
  single() {
    this.isSingle = true;
    return this;
  }

  private missingIn(keys: string[]): string | null {
    return keys.find((k) => this.missing.has(k)) ?? null;
  }

  private run(): { data: unknown; error: { message: string; code?: string } | null } {
    const rows = (this.db.tables[this.table] ??= []);
    const matches = rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.op === 'insert' || this.op === 'update') {
      const bad = this.missingIn(Object.keys(this.payload ?? {}));
      if (bad) {
        return { data: null, error: { code: 'PGRST204', message: `Could not find the '${bad}' column of '${this.table}' in the schema cache` } };
      }
    }
    if (this.op === 'insert') {
      rows.push(structuredClone(this.payload!));
      return { data: this.returning ? [structuredClone(this.payload!)] : null, error: null };
    }
    if (this.op === 'update') {
      for (const r of matches) Object.assign(r, structuredClone(this.payload!));
      return { data: this.returning ? matches.map((r) => structuredClone(r)) : null, error: null };
    }
    if (this.op === 'delete') {
      this.db.tables[this.table] = rows.filter((r) => !matches.includes(r));
      return { data: null, error: null };
    }
    const cols = this.selectCols === '*' ? [] : this.selectCols.split(',').map((c) => c.trim());
    const bad = this.missingIn(cols);
    if (bad) return { data: null, error: { code: '42703', message: `column ${this.table}.${bad} does not exist` } };
    let out = matches.map((r) => structuredClone(r));
    if (this.orderBy) {
      const { col, asc } = this.orderBy;
      out.sort((a, b) => String(a[col] ?? '').localeCompare(String(b[col] ?? '')) * (asc ? 1 : -1));
    }
    if (this.max !== null) out = out.slice(0, this.max);
    if (this.isSingle) return out[0] ? { data: out[0], error: null } : { data: null, error: { message: 'no rows' } };
    return { data: out, error: null };
  }

  then<A = { data: unknown; error: { message: string; code?: string } | null }, B = never>(
    onfulfilled?: ((value: { data: unknown; error: { message: string; code?: string } | null }) => A | PromiseLike<A>) | null,
    onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null
  ): PromiseLike<A | B> {
    return Promise.resolve(this.run()).then(onfulfilled, onrejected);
  }
}

/** A fake DB; `missingColumns` per table lists columns it doesn't have (migration not applied). */
export function createFakeDb(missingColumns: Record<string, string[]> = {}): FakeDb {
  const db: FakeDb = { tables: {}, client: null as unknown as SupabaseClient };
  db.client = {
    from: (table: string) => new Query(db, table, new Set(missingColumns[table] ?? [])),
  } as unknown as SupabaseClient;
  return db;
}
