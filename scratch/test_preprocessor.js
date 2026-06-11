const { preprocessInvoice } = require('../src/agents/preprocessor/index.ts');
require('dotenv').config({ path: '.env.local' });

// We can compile the TS file using ts-node or just load it after building, or since we're using ts-node/register
// we can require ts-node/register to run it directly from js. Let's do that!
require('ts-node').register({
  compilerOptions: {
    module: 'commonjs',
    paths: {
      '@/*': ['./src/*']
    }
  }
});

const preprocessor = require('../src/agents/preprocessor/index.ts');

async function test() {
  const fileUrl = 'https://kpapnvjncwkoeqpfscwr.supabase.co/storage/v1/object/sign/raw-invoices/test-invoice.pdf'; // sample URL
  const mimeType = 'application/pdf';

  console.log('Running preprocessor test...');
  try {
    const result = await preprocessor.preprocessInvoice(fileUrl, mimeType);
    console.log('OCR Results:', JSON.stringify(result, null, 2));
  } catch (error) {
    console.error('Error during OCR test:', error.message);
  }
}

test();
