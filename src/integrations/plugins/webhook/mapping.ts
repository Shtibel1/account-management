import type { ExportInvoice, IntegrationEnvironment, InvoiceMapping } from '@/integrations/types';

/** JSON document POSTed to the office's webhook for one invoice (version 1). */
export interface WebhookInvoicePayload {
  event: 'invoice.export';
  version: 1;
  environment: IntegrationEnvironment;
  idempotency_key: string;
  invoice: {
    id: string;
    file_name: string;
    invoice_number: string | null;
    invoice_date: string | null;
    allocation_number: string | null;
    currency: 'ILS';
    supplier: { name: string | null; vat_id: string | null; account_code: string; account_is_fallback: boolean };
    expense: { category: string | null; account_code: string | null };
    vat_account: string;
    amounts: { before_vat: number | null; vat: number | null; total: number | null };
    line_items: { description: string | null; quantity: number | null; unit_price: number | null; line_total: number | null }[];
  };
}

/** Stable per client + invoice: the receiver can use it to drop repeated deliveries. */
export function webhookIdempotencyKey(clientId: string, invoiceId: string): string {
  return `invoice-scan:${clientId}:${invoiceId}`;
}

export function toWebhookPayload(
  invoice: ExportInvoice,
  mapping: InvoiceMapping,
  environment: IntegrationEnvironment
): WebhookInvoicePayload {
  const d = invoice.data;
  return {
    event: 'invoice.export',
    version: 1,
    environment,
    idempotency_key: webhookIdempotencyKey(invoice.clientId, invoice.id),
    invoice: {
      id: invoice.id,
      file_name: invoice.fileName,
      invoice_number: d.invoice_number,
      invoice_date: d.invoice_date,
      allocation_number: d.allocation_number ?? null,
      currency: 'ILS',
      supplier: {
        name: d.supplier_name,
        vat_id: d.supplier_vat_id,
        account_code: mapping.supplierAccount,
        account_is_fallback: mapping.supplierAccountIsFallback,
      },
      expense: { category: d.expense_category, account_code: mapping.expenseAccount },
      vat_account: mapping.vatAccount,
      amounts: { before_vat: d.amount_before_vat, vat: d.vat_amount, total: d.total_amount },
      line_items: (d.line_items ?? []).map((li) => ({
        description: li.description, quantity: li.quantity, unit_price: li.unit_price, line_total: li.line_total,
      })),
    },
  };
}
