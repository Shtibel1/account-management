const path = require('path');
const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, '../.env.local') });

const { createClient } = require('@supabase/supabase-js');

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY;

const supabase = createClient(url, key);

async function main() {
  const id = 'a0651c28-a4fa-4bf0-9783-54e43e01b25d';
  console.log(`Fetching invoice details for ID: ${id}...`);
  
  const { data, error } = await supabase
    .from('invoices')
    .select('*')
    .eq('id', id)
    .single();
    
  if (error) {
    console.error('Error fetching invoice:', error);
    return;
  }
  
  console.log('Invoice Database Record:');
  console.log('ID:', data.id);
  console.log('Client ID:', data.client_id);
  console.log('File Name:', data.file_name);
  console.log('File URL:', data.file_url);
  console.log('Status:', data.status);
  console.log('Error Message:', data.error_message);
}

main();
