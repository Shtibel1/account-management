/**
 * Helper function to look up the official VAT ID (ח.פ. / מספר תאגיד) 
 * from the Israeli Government open data portal (data.gov.il) CKAN API.
 */
export async function searchVatIdByName(supplierName: string): Promise<string | null> {
  if (!supplierName || supplierName.trim().length < 2) return null;
  
  const query = supplierName.trim();
  
  // Official Gov.il Resource IDs for:
  // 1. Registered Companies (רשימת חברות)
  const COMPANIES_RES = 'f004176c-b85f-4542-8901-7b3176f9a054';
  // 2. Partnerships (רשימת שותפויות)
  const PARTNERSHIPS_RES = '139aa193-fabb-4f6b-a71b-0bb40fd73eb2';
  // 3. Registered Non-Profits/Amutot (עמותות רשומות)
  const NON_PROFITS_RES = 'be5b7935-3922-45d4-9638-08871b17ec95';

  const endpoints = [
    `https://data.gov.il/api/3/action/datastore_search?resource_id=${COMPANIES_RES}&q=${encodeURIComponent(query)}&limit=5`,
    `https://data.gov.il/api/3/action/datastore_search?resource_id=${PARTNERSHIPS_RES}&q=${encodeURIComponent(query)}&limit=5`,
    `https://data.gov.il/api/3/action/datastore_search?resource_id=${NON_PROFITS_RES}&q=${encodeURIComponent(query)}&limit=5`
  ];

  try {
    console.log(`[businessLookup] Querying Gov.il API for supplier: "${query}"`);
    
    // Query Gov.il APIs concurrently
    const responses = await Promise.all(
      endpoints.map(url => 
        fetch(url)
          .then(async r => {
            if (!r.ok) {
              console.warn(`[businessLookup] Gov.il request failed: ${url} status ${r.status}`);
              return null;
            }
            return r.json();
          })
          .catch(err => {
            console.error(`[businessLookup] Fetch error for URL: ${url}`, err);
            return null;
          })
      )
    );
    
    const clean = (s: string) => 
      s.replace(/["'׳״()~]|בע.?מ|ע.?ר|בע"מ|בע~מ|למיקוד|בפירוק|LTD|שותפות/gi, '')
       .replace(/\s+/g, ' ')
       .trim();

    const cleanQuery = clean(query);

    // 1. Parse Companies
    const companyRecords = responses[0]?.result?.records || [];
    for (const rec of companyRecords) {
      const name = rec['שם חברה'] || '';
      const num = rec['מספר חברה'];
      if (name && num) {
        const cleanName = clean(name);
        if (cleanName.includes(cleanQuery) || cleanQuery.includes(cleanName)) {
          return String(num).trim();
        }
      }
    }

    // 2. Parse Partnerships
    const partnershipRecords = responses[1]?.result?.records || [];
    for (const rec of partnershipRecords) {
      const name = rec['שם שותפות'] || '';
      const num = rec['מספר שותפות'];
      if (name && num) {
        const cleanName = clean(name);
        if (cleanName.includes(cleanQuery) || cleanQuery.includes(cleanName)) {
          return String(num).trim();
        }
      }
    }

    // 3. Parse Non-Profits (Amutot)
    const nonProfitRecords = responses[2]?.result?.records || [];
    for (const rec of nonProfitRecords) {
      const name = rec['שם עמותה בעברית'] || '';
      const num = rec['מספר עמותה'];
      if (name && num) {
        const cleanName = clean(name);
        if (cleanName.includes(cleanQuery) || cleanQuery.includes(cleanName)) {
          return String(num).trim();
        }
      }
    }

    // Fallback: If no direct substring match but we got records, return the first one returned by CKAN rank
    if (companyRecords.length > 0 && companyRecords[0]['מספר חברה']) {
      return String(companyRecords[0]['מספר חברה']).trim();
    }
    if (partnershipRecords.length > 0 && partnershipRecords[0]['מספר שותפות']) {
      return String(partnershipRecords[0]['מספר שותפות']).trim();
    }
    if (nonProfitRecords.length > 0 && nonProfitRecords[0]['מספר עמותה']) {
      return String(nonProfitRecords[0]['מספר עמותה']).trim();
    }

    return null;
  } catch (err) {
    console.error('[businessLookup] Unhandled lookup exception:', err);
    return null;
  }
}
