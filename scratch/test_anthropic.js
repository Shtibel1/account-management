const Anthropic = require('@anthropic-ai/sdk');
require('dotenv').config({ path: '.env.local' });

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error("No ANTHROPIC_API_KEY found in .env.local");
  process.exit(1);
}

const anthropic = new Anthropic({ apiKey });

const testModels = [
  'claude-sonnet-4-20250514',
  'claude-sonnet-4-5-20250929',
  'claude-sonnet-4-6'
];

async function runTest() {
  for (const model of testModels) {
    try {
      console.log(`Testing messages creation with model: ${model}...`);
      const response = await anthropic.messages.create({
        model: model,
        max_tokens: 10,
        messages: [{ role: 'user', content: 'Hi, please say hello.' }]
      });
      console.log(`✅ Success with ${model}! Response: ${response.content[0].text}`);
    } catch (error) {
      console.error(`❌ Failed for ${model}: ${error.status} - ${error.message}`);
    }
  }
}

runTest();
