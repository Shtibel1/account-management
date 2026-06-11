import type { ExtractedData } from '@/shared/types';

const API_URL = process.env.NEXT_PUBLIC_API_URL || '';

export async function uploadInvoices(clientId: string, files: File[]) {
  const form = new FormData();
  form.append('clientId', clientId);
  files.forEach((f) => form.append('files', f));
  const res = await fetch(`${API_URL}/api/invoices/upload`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
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
