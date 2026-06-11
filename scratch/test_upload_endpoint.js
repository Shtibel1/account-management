const path = require('path');
const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, '../.env.local') });

async function main() {
  const clientId = '91b5c0b4-aa38-41bf-a67e-5b0ea41d2cc8';
  
  // We will construct FormData manually.
  // In Node 18+, FormData and Blob are globally available.
  const formData = new FormData();
  formData.append('clientId', clientId);
  
  // Create a mock file with Hebrew characters in its name
  const mockFileContent = 'mock image data';
  const fileBlob = new Blob([mockFileContent], { type: 'image/png' });
  formData.append('files', fileBlob, 'זיכוי-חשבונית-מס-קבלה.png');
  
  console.log('Sending upload request to http://localhost:3001/api/invoices/upload...');
  
  try {
    const res = await fetch('http://localhost:3001/api/invoices/upload', {
      method: 'POST',
      body: formData
    });
    
    console.log('Response status:', res.status);
    const json = await res.json();
    console.log('Response JSON:', JSON.stringify(json, null, 2));
  } catch (err) {
    console.error('Fetch request failed:', err);
  }
}

main();
