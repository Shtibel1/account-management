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
  console.log('Fetching account_mappings info...');
  const { data, error } = await supabase
    .from('account_mappings')
    .select('*')
    .limit(1);

  if (error) {
    console.error('Error:', error);
  } else {
    console.log('Sample row from account_mappings:', data);
  }

  // Fetch Postgrest OpenAPI schema
  try {
    const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
  } catch (e) {}

  const fetchUrl = `${url}/rest/v1/`;
  console.log('Fetching Postgrest schema from:', fetchUrl);
  const res = await fetch(fetchUrl, {
    headers: {
      'apikey': key,
      'Authorization': `Bearer ${key}`
    }
  });
  if (res.ok) {
    const schema = await res.json();
    console.log('Tables found in schema:', Object.keys(schema.definitions || {}));
    const rpcs = Object.keys(schema.paths || {}).filter(p => p.startsWith('/rpc/'));
    console.log('RPC functions found:', rpcs);
    if (schema.definitions && schema.definitions.account_mappings) {
      console.log('account_mappings properties:', schema.definitions.account_mappings.properties);
    } else {
      console.log('account_mappings definition not found in OpenAPI spec.');
    }
  } else {
    console.error('Failed to fetch schema:', res.status, await res.text());
  }
}

run();
