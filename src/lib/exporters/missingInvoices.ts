import type { BankTransaction } from '@/shared/types';
import { isMatchableDebit } from '@/shared/bankMatch';

// "Missing invoices" sheet the accountant sends to the client: every debit without a matching invoice.

export const MISSING_INVOICES_HEADERS = ['תאריך', 'חשבון / כרטיס', 'תיאור', 'אסמכתא', 'סכום (₪)', 'הערות הלקוח'] as const;

export type MissingInvoicesCell = string | number;

/** YYYY-MM-DD -> DD/MM/YYYY */
export function formatIsoDateHe(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

export function missingInvoiceTransactions(transactions: BankTransaction[]): BankTransaction[] {
  return transactions
    .filter(isMatchableDebit)
    .sort((a, b) => a.txn_date.localeCompare(b.txn_date) || a.description.localeCompare(b.description));
}

/** Header + one row per missing invoice + a total row (amounts as positive numbers). */
export function missingInvoicesSheetRows(transactions: BankTransaction[]): MissingInvoicesCell[][] {
  const missing = missingInvoiceTransactions(transactions);
  const total = Math.round(missing.reduce((sum, t) => sum + Math.abs(t.amount), 0) * 100) / 100;
  return [
    [...MISSING_INVOICES_HEADERS],
    ...missing.map((t) => [
      formatIsoDateHe(t.txn_date),
      t.account_label,
      t.description,
      t.reference ?? '',
      Math.abs(t.amount),
      '',
    ]),
    ['', '', `סה"כ (${missing.length} תנועות)`, '', total, ''],
  ];
}

/** Builds the sheet and triggers a browser download. */
export async function downloadMissingInvoicesXlsx(transactions: BankTransaction[], clientName: string): Promise<void> {
  const XLSX = await import('xlsx');
  const ws = XLSX.utils.aoa_to_sheet(missingInvoicesSheetRows(transactions));
  ws['!cols'] = [{ wch: 12 }, { wch: 18 }, { wch: 40 }, { wch: 14 }, { wch: 12 }, { wch: 30 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'חשבוניות חסרות');
  wb.Workbook = { Views: [{ RTL: true }] };
  const safeName = clientName.replace(/[\/:*?"<>|]/g, '').trim() || 'לקוח';
  const today = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(wb, `חשבוניות-חסרות-${safeName}-${today}.xlsx`);
}
