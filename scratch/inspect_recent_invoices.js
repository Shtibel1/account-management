const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY;

if (!url || !key) {
  console.error('Missing env vars');
  process.exit(1);
}

const supabase = createClient(url, key);

async function run() {
  console.log('Fetching most recent invoice...');
  const { data, error } = await supabase
    .from('invoices')
    .select('id, file_name, status, extracted_data, error_message, created_at')
    .order('created_at', { ascending: false })
    .limit(1);

  if (error) {
    console.error('Error fetching invoices:', error);
  } else {
    console.log(JSON.stringify(data[0], null, 2));
  }
}

run();
