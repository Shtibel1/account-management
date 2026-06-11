import type { AccountMapping, Invoice } from '@/shared/types';
import { toVisualHebrew, encodeWindows1255 } from '@/utils/encoding';

export class MoveinExporter {
  export(invoices: Invoice[], mappings: AccountMapping[], clientVatAccount: string): Buffer {
    const lines: string[] = [];

    for (const inv of invoices) {
      const data = inv.validated_data ?? inv.extracted_data;
      if (!data) continue;

      const supplierAccount = this.lookupCode(mappings, 'supplier', data.supplier_name);
      const expenseAccount  = this.lookupCode(mappings, 'category', data.expense_category);
      const invoiceNumber   = data.invoice_number ?? '';
      const invoiceDate     = this.formatDate(data.invoice_date);
      
      const supplierName    = data.supplier_name ?? '';
      const supplierVatId   = data.supplier_vat_id ?? '';
      
      const totalAmount     = data.total_amount ?? 0;
      const netAmount       = data.amount_before_vat ?? 0;
      const vatAmount       = data.vat_amount ?? 0;

      // Construct bank details string: Bank Name Branch Name מס' סניף : Branch Code מספר חשבון : Account Number
      const bankParts: string[] = [];
      if (data.bank_name) bankParts.push(data.bank_name);
      if (data.bank_branch_name) bankParts.push(data.bank_branch_name);
      if (data.bank_branch_code) bankParts.push(`מס' סניף : ${data.bank_branch_code}`);
      if (data.bank_account) bankParts.push(`מספר חשבון : ${data.bank_account}`);
      const bankDetails = bankParts.join(' ');

      lines.push(
        this.buildLine(
          invoiceNumber,
          invoiceDate,
          supplierAccount === '???' ? '' : supplierAccount,
          expenseAccount === '???' ? '' : expenseAccount,
          supplierName,
          supplierVatId,
          clientVatAccount,
          totalAmount,
          netAmount,
          vatAmount,
          bankDetails
        )
      );
    }

    // Join with CR-LF and convert to a Windows-1255 encoded buffer
    const fileContent = lines.join('\r\n') + '\r\n';
    return encodeWindows1255(fileContent);
  }

  private buildLine(
    invoiceNumber: string,
    invoiceDate: string,
    supplierAccount: string,
    expenseAccount: string,
    supplierName: string,
    supplierVatId: string,
    clientVatAccount: string,
    totalAmount: number,
    netAmount: number,
    vatAmount: number,
    bankDetails: string
  ): string {
    const transactionType = 'לח';
    const vatDescription = 'מעמ ע';

    return (
      this.padLeft(transactionType, 3) + // starts at 0, length 3
      this.padLeft(invoiceNumber, 9) +   // starts at 3, length 9
      this.padLeft('', 9) +              // starts at 12, length 9
      this.padLeft(invoiceDate, 10) +    // starts at 21, length 10
      this.padLeft(invoiceDate, 10) +    // starts at 31, length 10
      this.padLeft(supplierAccount, 15) + // starts at 41, length 15
      this.padLeft(expenseAccount, 15) +  // starts at 56, length 15
      this.padLeft('', 5) +              // starts at 71, length 5
      this.padLeft(toVisualHebrew(supplierName), 50) + // starts at 76, length 50
      this.padLeft(supplierVatId, 15) +  // starts at 126, length 15
      this.padLeft('', 15) +             // starts at 141, length 15
      this.padLeft(clientVatAccount, 15) + // starts at 156, length 15
      this.padLeft(toVisualHebrew(vatDescription), 15) + // starts at 171, length 15
      this.padLeft(totalAmount.toFixed(2), 12) + // starts at 186, length 12
      this.padLeft('', 12) +             // starts at 198, length 12
      this.padLeft(netAmount.toFixed(2), 12) + // starts at 210, length 12
      this.padLeft(vatAmount.toFixed(2), 12) + // starts at 222, length 12
      this.padLeft('', 48) +             // starts at 234, length 48
      this.padLeft(toVisualHebrew(bankDetails), 50) // starts at 282, length 50
    );
  }

  private formatDate(dateStr: string | null): string {
    if (!dateStr) return '00/00/0000';
    // YYYY-MM-DD → DD/MM/YYYY
    const parts = dateStr.split('-');
    if (parts.length !== 3) return '00/00/0000';
    const [yyyy, mm, dd] = parts;
    return `${dd}/${mm}/${yyyy}`;
  }

  private padLeft(s: string, len: number): string {
    return s.slice(0, len).padStart(len, ' ');
  }

  private lookupCode(mappings: AccountMapping[], type: 'supplier' | 'category', key: string | null): string {
    if (!key) return '';
    const m = mappings.find((m) => m.mapping_type === type && m.key === key);
    return m?.account_code ?? '???';
  }
}
