import type { ExtractedData } from '@/shared/types';

const API_URL = process.env.NEXT_PUBLIC_API_URL || '';

export async function uploadInvoices(clientId: string, files: File[]) {
  const uploadedFiles: { filePath: string; fileName: string; mimeType: string }[] = [];
  const results: { fileName: string; status: 'success' | 'error'; id?: string; error?: string }[] = [];

  for (const file of files) {
    try {
      // 1. Get presigned upload URL
      const urlRes = await fetch(`${API_URL}/api/invoices/upload-url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId, fileName: file.name, mimeType: file.type }),
      });
      if (!urlRes.ok) {
        throw new Error(`Failed to get upload URL: ${await urlRes.text()}`);
      }
      const { signedUrl, filePath } = await urlRes.json();

      // 2. Upload file directly to Supabase Storage via PUT
      const uploadRes = await fetch(signedUrl, {
        method: 'PUT',
        body: file,
        headers: {
          'Content-Type': file.type,
        },
      });
      if (!uploadRes.ok) {
        throw new Error(`Failed to upload to storage: ${uploadRes.statusText}`);
      }

      uploadedFiles.push({
        filePath,
        fileName: file.name,
        mimeType: file.type,
      });
    } catch (err: any) {
      console.error(`Error uploading ${file.name}:`, err);
      results.push({
        fileName: file.name,
        status: 'error',
        error: err.message || String(err),
      });
    }
  }

  // If none of the files succeeded, return the errors immediately
  if (uploadedFiles.length === 0) {
    return { results, count: results.length };
  }

  // 3. Call server to process the uploaded files
  try {
    const res = await fetch(`${API_URL}/api/invoices/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId,
        files: uploadedFiles,
      }),
    });
    if (!res.ok) {
      throw new Error(await res.text());
    }
    const serverResponse = await res.json();
    
    // 4. Initiate client-side asynchronous dispatch to trigger pipeline processing
    if (serverResponse.results && Array.isArray(serverResponse.results)) {
      for (const result of serverResponse.results) {
        if (result.status === 'success' && result.id && result.fileUrl) {
          const uf = uploadedFiles.find((f) => f.fileName === result.fileName);
          const mimeType = uf ? uf.mimeType : 'application/pdf';

          // Trigger processing asynchronously (fire-and-forget)
          fetch(`${API_URL}/api/invoices/${result.id}/process`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              fileUrl: result.fileUrl,
              mimeType,
              tenantId: clientId,
            }),
          }).catch((err) => {
            console.error(`[Frontend API] Failed to trigger processing for invoice ${result.id}:`, err);
          });
        }
      }
    }

    // Combine results
    const combinedResults = [...results, ...(serverResponse.results || [])];
    return {
      results: combinedResults,
      count: combinedResults.length,
    };
  } catch (err: any) {
    const failedResults = [
      ...results,
      ...uploadedFiles.map((uf) => ({
        fileName: uf.fileName,
        status: 'error' as const,
        error: `Server failed to start processing: ${err.message || String(err)}`,
      })),
    ];
    return { results: failedResults, count: failedResults.length };
  }
}

export async function approveInvoice(id: string, validatedData: Partial<ExtractedData>) {
  const res = await fetch(`${API_URL}/api/invoices/${id}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ validated_data: validatedData }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export class MissingMappingsError extends Error {
  constructor(public readonly missing: string[]) {
    super('מיפויים חסרים');
  }
}

export async function exportInvoices(ids: string[]) {
  const res = await fetch(`${API_URL}/api/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    if (res.status === 422 && body?.missing?.length) {
      throw new MissingMappingsError(body.missing as string[]);
    }
    throw new Error(body?.error ?? 'שגיאה בייצוא');
  }
  return res.blob();
}

export async function splitInvoice(
  id: string,
  splits: { startPage: number; endPage: number }[],
  tenantId: string
) {
  const res = await fetch(`${API_URL}/api/invoices/${id}/split`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ splits }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(errorText || 'שגיאה בפיצול הקובץ');
  }

  const data = await res.json();

  // Trigger background process for each split part
  if (data.invoices && Array.isArray(data.invoices)) {
    for (const inv of data.invoices) {
      fetch(`${API_URL}/api/invoices/${inv.id}/process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileUrl: inv.fileUrl,
          mimeType: inv.mimeType || 'application/pdf',
          tenantId,
        }),
      }).catch((err) => {
        console.error(`[Frontend API] Failed to trigger processing for split invoice ${inv.id}:`, err);
      });
    }
  }

  return data;
}
