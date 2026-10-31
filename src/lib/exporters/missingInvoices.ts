import type { BankTransaction } from '@/shared/types';
import { isMatchableDebit } from '@/shared/bankMatch';
import { countHe } from '@/shared/hebrewCount';

// "Missing invoices" sheet the accountant sends to the client: every debit without a matching invoice.

/** The columns the sheet needs (the export loads only these, see /api/bank/missing). */
export type MissingInvoiceLine = Pick<BankTransaction, 'txn_date' | 'account_label' | 'description' | 'reference' | 'amount'> &
  Partial<Pick<BankTransaction, 'match_status'>>;

export const MISSING_INVOICES_HEADERS = ['תאריך', 'חשבון / כרטיס', 'תיאור', 'אסמכתא', 'סכום (₪)', 'הערות הלקוח'] as const;

export type MissingInvoicesCell = string | number;

/** YYYY-MM-DD -> DD/MM/YYYY */
export function formatIsoDateHe(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

export function missingInvoiceTransactions<T extends MissingInvoiceLine>(transactions: T[]): T[] {
  return transactions
    // Lines without a status come from the export query, which returns unmatched debits only
    .filter((t) => isMatchableDebit({ amount: t.amount, match_status: t.match_status ?? 'unmatched' }))
    .sort((a, b) => a.txn_date.localeCompare(b.txn_date) || a.description.localeCompare(b.description));
}

/** Header + one row per missing invoice + a total row (amounts as positive numbers). */
export function missingInvoicesSheetRows(transactions: MissingInvoiceLine[]): MissingInvoicesCell[][] {
  const missing = missingInvoiceTransactions(transactions);
  // Summed in whole agorot: float sums drift by 0.01 over ~100k lines (QA round 5 #4)
  const totalAgorot = missing.reduce((sum, t) => sum + Math.round(Math.abs(t.amount) * 100), 0);
  const total = totalAgorot / 100;
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
    ['', '', `סה"כ (${countHe(missing.length, 'transaction')})`, '', total, ''],
  ];
}

/** Builds the sheet and triggers a browser download. */
export async function downloadMissingInvoicesXlsx(transactions: MissingInvoiceLine[], clientName: string): Promise<void> {
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
