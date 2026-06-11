import { readDb, writeDb } from './mockDb';

const fs = typeof window === 'undefined' ? eval("require('fs')") : null;
const path = typeof window === 'undefined' ? eval("require('path')") : null;

function generateId() {
  return Math.random().toString(36).substring(2, 10) + '-' + Math.random().toString(36).substring(2, 10);
}

export class MockQueryBuilder {
  private table: string;
  private filterChain: ((item: any) => boolean)[] = [];
  private orderCol: string | null = null;
  private orderAscending = true;
  private isSingle = false;
  private isDelete = false;
  private updateData: any = null;
  private insertData: any = null;
  private checkInFilters: { col: string; vals: any[] }[] = [];

  constructor(table: string) {
    this.table = table;
  }

  select(cols?: string) {
    return this;
  }

  eq(col: string, val: any) {
    this.filterChain.push((item: any) => item[col] === val);
    return this;
  }

  in(col: string, vals: any[]) {
    this.checkInFilters.push({ col, vals });
    return this;
  }

  order(col: string, options?: { ascending?: boolean }) {
    this.orderCol = col;
    this.orderAscending = options?.ascending !== false;
    return this;
  }

  single() {
    this.isSingle = true;
    return this;
  }

  insert(data: any) {
    this.insertData = data;
    return this;
  }

  update(data: any) {
    this.updateData = data;
    return this;
  }

  delete() {
    this.isDelete = true;
    return this;
  }

  async execute() {
    const db = await readDb();
    if (!db[this.table]) {
      db[this.table] = [];
    }
    let list = [...db[this.table]];

    // Apply in filters
    for (const filter of this.checkInFilters) {
      list = list.filter((item) => filter.vals.includes(item[filter.col]));
    }

    // Apply eq filters
    for (const filter of this.filterChain) {
      list = list.filter(filter);
    }

    // Apply order
    if (this.orderCol) {
      list.sort((a, b) => {
        const valA = a[this.orderCol!];
        const valB = b[this.orderCol!];
        if (valA === valB) return 0;
        if (valA == null) return this.orderAscending ? -1 : 1;
        if (valB == null) return this.orderAscending ? 1 : -1;
        if (typeof valA === 'string' && typeof valB === 'string') {
          return this.orderAscending ? valA.localeCompare(valB) : valB.localeCompare(valA);
        }
        return this.orderAscending ? (valA < valB ? -1 : 1) : (valA > valB ? -1 : 1);
      });
    }

    if (this.insertData) {
      const isArray = Array.isArray(this.insertData);
      const dataToInsert = isArray ? this.insertData : [this.insertData];
      const insertedItems: any[] = [];

      for (const item of dataToInsert) {
        const newItem = {
          id: generateId(),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          ...item,
        };
        db[this.table].push(newItem);
        insertedItems.push(newItem);
      }

      await writeDb(db);
      return {
        data: isArray ? insertedItems : insertedItems[0],
        error: null,
      };
    }

    if (this.updateData) {
      const idsToUpdate = list.map((item) => item.id);
      db[this.table] = db[this.table].map((item: any) => {
        if (idsToUpdate.includes(item.id)) {
          return {
            ...item,
            ...this.updateData,
            updated_at: new Date().toISOString(),
          };
        }
        return item;
      });

      await writeDb(db);
      
      const updatedDb = await readDb();
      let updatedList = [...updatedDb[this.table]];
      for (const filter of this.checkInFilters) {
        updatedList = updatedList.filter((item) => filter.vals.includes(item[filter.col]));
      }
      for (const filter of this.filterChain) {
        updatedList = updatedList.filter(filter);
      }
      return {
        data: this.isSingle ? updatedList[0] : updatedList,
        error: null,
      };
    }

    if (this.isDelete) {
      const idsToDelete = list.map((item) => item.id);
      db[this.table] = db[this.table].filter((item: any) => !idsToDelete.includes(item.id));
      await writeDb(db);
      return {
        data: null,
        error: null,
      };
    }

    const resultData = this.isSingle ? list[0] : list;
    return {
      data: resultData || (this.isSingle ? null : []),
      error: null,
    };
  }

  then(onfulfilled?: (value: any) => any, onrejected?: (reason: any) => any) {
    return this.execute().then(onfulfilled, onrejected);
  }
}

export const mockStorage = {
  from(bucket: string) {
    return {
      async upload(filePath: string, fileData: any, options?: any) {
        try {
          if (typeof window === 'undefined') {
            // Node server side
            const destPath = path.join(process.cwd(), 'public', 'uploads', bucket, filePath);
            const dir = path.dirname(destPath);
            if (!fs.existsSync(dir)) {
              fs.mkdirSync(dir, { recursive: true });
            }
            let buffer: Buffer;
            if (Buffer.isBuffer(fileData)) {
              buffer = fileData;
            } else if (fileData instanceof ArrayBuffer) {
              buffer = Buffer.from(fileData);
            } else if (typeof fileData.arrayBuffer === 'function') {
              buffer = Buffer.from(await fileData.arrayBuffer());
            } else {
              buffer = Buffer.from(fileData);
            }
            fs.writeFileSync(destPath, buffer);
          }
          return { data: { path: filePath }, error: null };
        } catch (e) {
          console.error('Mock storage upload error:', e);
          return { data: null, error: e as Error };
        }
      },
      async createSignedUrl(filePath: string, expires: number) {
        const relativeUrl = `/uploads/${bucket}/${filePath}`;
        return { data: { signedUrl: relativeUrl }, error: null };
      }
    };
  }
};

export const mockClient = {
  from(table: string) {
    return new MockQueryBuilder(table);
  },
  channel(name: string) {
    return {
      on(event: string, filter: any, callback: () => void) {
        return this;
      },
      subscribe() {
        return this;
      }
    };
  },
  removeChannel(channel: any) {
    return Promise.resolve();
  },
  storage: mockStorage
};
