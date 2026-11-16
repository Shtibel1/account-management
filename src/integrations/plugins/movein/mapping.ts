import type { AccountMapping, Invoice } from '@/shared/types';
import type { ExportInvoice, InvoiceMapping } from '@/integrations/types';

/**
 * The Move-in file is built by the existing MoveinExporter from the raw invoices + the client's
 * account_mappings (it resolves the codes itself, with the same 3499 supplier fallback), so the
 * plugin hands it exactly what POST /api/export does. Output is byte-for-byte the same.
 */
export interface MoveinInput {
  invoices: Invoice[];
  accountMappings: AccountMapping[];
  vatAccount: string;
}

export function toMoveinInput(items: { invoice: ExportInvoice; mapping: InvoiceMapping }[]): MoveinInput {
  const first = items[0]?.mapping;
  return {
    invoices: items.map((i) => i.invoice.raw),
    accountMappings: first?.accountMappings ?? [],
    vatAccount: first?.vatAccount ?? '',
  };
}
