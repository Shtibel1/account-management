const fs = typeof window === 'undefined' ? eval("require('fs')") : null;
const path = typeof window === 'undefined' ? eval("require('path')") : null;

const DB_FILE = typeof window === 'undefined' ? path.join(process.cwd(), 'mock_db.json') : '';

function getInitialDb() {
  return {
    clients: [],
    invoices: [],
    account_mappings: []
  };
}

export async function readDb() {
  if (typeof window === 'undefined') {
    // Server side
    try {
      if (!fs.existsSync(DB_FILE)) {
        fs.writeFileSync(DB_FILE, JSON.stringify(getInitialDb(), null, 2));
      }
      const content = fs.readFileSync(DB_FILE, 'utf8');
      return JSON.parse(content);
    } catch (e) {
      console.error('Error reading mock DB file:', e);
      return getInitialDb();
    }
  } else {
    // Client side
    try {
      const res = await fetch('/api/mock-db');
      if (!res.ok) throw new Error('Failed to fetch mock db');
      return await res.json();
    } catch (e) {
      console.error('Error fetching mock DB:', e);
      return getInitialDb();
    }
  }
}

export async function writeDb(db: any) {
  if (typeof window === 'undefined') {
    // Server side
    try {
      fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
    } catch (e) {
      console.error('Error writing mock DB file:', e);
    }
  } else {
    // Client side
    try {
      const res = await fetch('/api/mock-db', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(db),
      });
      if (!res.ok) throw new Error('Failed to save mock db');
    } catch (e) {
      console.error('Error posting mock DB:', e);
    }
  }
}
