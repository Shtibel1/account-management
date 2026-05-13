const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export async function uploadInvoices(clientId: string, files: File[]) {
  const form = new FormData();
  form.append('clientId', clientId);
  files.forEach((f) => form.append('files', f));
  const res = await fetch(`${API_URL}/api/invoices/upload`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function approveInvoice(id: string, validatedData: object) {
  const res = await fetch(`${API_URL}/api/invoices/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ validated_data: validatedData, status: 'approved' }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function exportInvoices(ids: string[]) {
  const res = await fetch(`${API_URL}/api/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.blob();
}
