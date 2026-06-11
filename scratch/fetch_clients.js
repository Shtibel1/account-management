const path = require('path');
const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, '../.env.local') });

const { createClient } = require('@supabase/supabase-js');

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY;

if (!url || !key) {
  console.error('Supabase URL or Key is missing from .env.local');
  process.exit(1);
}

const supabase = createClient(url, key);

async function main() {
  const { data: clients, error } = await supabase.from('clients').select('id, name');
  if (error) {
    console.error('Error fetching clients:', error);
    return;
  }
  console.log('Clients:', clients);
}

main();
