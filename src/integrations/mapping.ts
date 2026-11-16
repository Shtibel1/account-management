import type { AccountMapping, Invoice } from '@/shared/types';
import type { ExportInvoice, InvoiceMapping } from '@/integrations/types';

/** Supplier code used when a supplier has no mapping (same fallback as the Move-in exporter). */
export const FALLBACK_SUPPLIER_ACCOUNT = '3499';

/** Statuses that may be exported by a plugin ("exported" = already sent to another target). */
export const EXPORTABLE_STATUSES = ['approved', 'exported'] as const;

export function isExportableStatus(status: string): boolean {
  return (EXPORTABLE_STATUSES as readonly string[]).includes(status);
}

/** The invoice in plugin form, or null when it has no data at all. */
export function toExportInvoice(invoice: Invoice): ExportInvoice | null {
  const data = invoice.validated_data ?? invoice.extracted_data;
  if (!data) return null;
  return {
    id: invoice.id,
    clientId: invoice.client_id,
    status: invoice.status,
    fileName: invoice.file_name,
    fileUrl: invoice.file_url,
    data,
    raw: invoice,
  };
}

function lookup(mappings: AccountMapping[], type: 'supplier' | 'category', key: string | null | undefined): string | null {
  if (!key) return null;
  return mappings.find((m) => m.mapping_type === type && m.key === key)?.account_code ?? null;
}

/** Resolves account codes for an invoice from the client's account_mappings (pure). */
export function resolveInvoiceMapping(invoice: ExportInvoice, accountMappings: AccountMapping[], vatAccount: string): InvoiceMapping {
  const { data } = invoice;
  const supplier = lookup(accountMappings, 'supplier', data.supplier_name);
  const expense = lookup(accountMappings, 'category', data.expense_category);
  const missing: string[] = [];
  if (data.expense_category && !expense) missing.push(`קטגוריה: ${data.expense_category}`);
  return {
    supplierAccount: supplier ?? FALLBACK_SUPPLIER_ACCOUNT,
    supplierAccountIsFallback: !supplier,
    expenseAccount: expense,
    vatAccount: vatAccount ?? '',
    missing,
    accountMappings,
  };
}
