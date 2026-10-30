import { isSpecificSupplierName, pickRegistrarMatch, type RegistrarRecord } from '@/shared/supplierNameMatch';

/** Per-request cap: the lookup runs inside the review form and the pipeline (each HTTP request is cut at ~28s). */
const REGISTRAR_TIMEOUT_MS = 6000;

/**
 * Helper function to look up the official VAT ID (ח.פ. / מספר תאגיד) 
 * from the Israeli Government open data portal (data.gov.il) CKAN API.
 */
export async function searchVatIdByName(supplierName: string): Promise<string | null> {
  // A placeholder ("ספקים שונים") or a generic word ("חברה", "דלק") is not one business: any
  // registrar hit would be an unrelated company whose number gets autofilled as the supplier's
  if (!isSpecificSupplierName(supplierName)) return null;
  
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
        fetch(url, { signal: AbortSignal.timeout(REGISTRAR_TIMEOUT_MS) })
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
    
    // A record must be the queried business as a whole, and an ambiguous query (several different
    // businesses match and none is named exactly like it) gives nothing (see pickRegistrarMatch)
    const records: RegistrarRecord[] = [
      ...(responses[0]?.result?.records || []).map((rec: any) => ({ name: rec['שם חברה'], number: rec['מספר חברה'] })),
      ...(responses[1]?.result?.records || []).map((rec: any) => ({ name: rec['שם שותפות'], number: rec['מספר שותפות'] })),
      ...(responses[2]?.result?.records || []).map((rec: any) => ({ name: rec['שם עמותה בעברית'], number: rec['מספר עמותה'] })),
    ];
    const picked = pickRegistrarMatch(query, records);
    if (picked) return picked;

    // No record whose name matches: return nothing. (The top full-text hit for a name that matches
    // no record is an unrelated business, and its number would be autofilled as the supplier's.)
    return null;
  } catch (err) {
    console.error('[businessLookup] Unhandled lookup exception:', err);
    return null;
  }
}
