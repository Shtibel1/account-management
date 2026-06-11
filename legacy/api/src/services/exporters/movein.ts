import type { AccountMapping, ExtractedData, Invoice } from '@invoice/shared-types';

/**
 * Move-in / חשבשבת fixed-width format:
 *
 * תווים  1–8   : תאריך אסמכתא (DDMMYYYY)
 * תווים  9–23  : מפתח חשבון ספק    (15 תווים, ימין, רווחים)
 * תווים 24–38  : מפתח חשבון נגדי   (15 תווים)
 * תווים 39–53  : סכום בשקלים+אגורות (15 תווים, יישור ימין, ללא נקודה)
 *
 * כל חשבונית → 2 שורות (הוצאה + מע"מ תשומות)
 */
export class MoveinExporter {
  export(invoices: Invoice[], mappings: AccountMapping[], clientVatAccount: string): Buffer {
    const lines: string[] = [];

    for (const inv of invoices) {
      const data = inv.validated_data ?? inv.extracted_data;
      if (!data) continue;

      const supplierAccount = this.lookupCode(mappings, 'supplier', data.supplier_name);
      const expenseAccount  = this.lookupCode(mappings, 'category', data.expense_category);
      const date            = this.formatDate(data.invoice_date);

      // שורה 1: הוצאה (לפני מע"מ)
      if (data.amount_before_vat != null) {
        lines.push(this.buildLine(date, supplierAccount, expenseAccount, data.amount_before_vat));
      }

      // שורה 2: מע"מ תשומות
      if (data.vat_amount != null && data.vat_amount > 0) {
        lines.push(this.buildLine(date, supplierAccount, clientVatAccount, data.vat_amount));
      }
    }

    return Buffer.from(lines.join('\r\n') + '\r\n', 'utf8');
  }

  private buildLine(date: string, supplierAccount: string, counterAccount: string, amount: number): string {
    return (
      this.padLeft(date, 8) +
      this.padLeft(supplierAccount, 15) +
      this.padLeft(counterAccount, 15) +
      this.padLeft(this.formatAmount(amount), 15)
    );
  }

  private formatDate(dateStr: string | null): string {
    if (!dateStr) return '00000000';
    // YYYY-MM-DD → DDMMYYYY
    const parts = dateStr.split('-');
    if (parts.length !== 3) return '00000000';
    const [yyyy, mm, dd] = parts;
    return `${dd}${mm}${yyyy}`;
  }

  private formatAmount(amount: number): string {
    // הופך לאגורות, ללא נקודה עשרונית
    return Math.round(amount * 100).toString();
  }

  private padLeft(s: string, len: number): string {
    return s.slice(0, len).padStart(len, ' ');
  }

  private lookupCode(mappings: AccountMapping[], type: 'supplier' | 'category', key: string | null): string {
    if (!key) return ''.padStart(15);
    const m = mappings.find((m) => m.mapping_type === type && m.key === key);
    return m?.account_code ?? '???';
  }
}
