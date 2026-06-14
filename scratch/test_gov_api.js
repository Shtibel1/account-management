const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

async function testPartnershipSearch() {
  const resourceId = '139aa193-fabb-4f6b-a71b-0bb40fd73eb2';
  const query = 'שותפות';
  const url = `https://data.gov.il/api/3/action/datastore_search?resource_id=${resourceId}&q=${encodeURIComponent(query)}&limit=1`;
  try {
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      console.log('Sample Partnership:', data.result?.records?.[0]);
    }
  } catch (err) {
    console.error(err);
  }
}

async function testNonProfitSearch() {
  const resourceId = 'be5b7935-3922-45d4-9638-08871b17ec95';
  const query = 'עמותה';
  const url = `https://data.gov.il/api/3/action/datastore_search?resource_id=${resourceId}&q=${encodeURIComponent(query)}&limit=1`;
  try {
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      console.log('Sample NonProfit:', data.result?.records?.[0]);
    }
  } catch (err) {
    console.error(err);
  }
}

async function run() {
  await testPartnershipSearch();
  await testNonProfitSearch();
}

run();
