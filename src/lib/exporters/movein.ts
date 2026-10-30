import type { AccountMapping, Invoice } from '@/shared/types';
import { toVisualHebrew, encodeWindows1255 } from '@/utils/encoding';

/**
 * Field widths of the Move-in fixed-width line (332 characters, see buildLine). Identifying fields
 * (reference, account codes, VAT ids, amounts) are never cut: an invoice whose value doesn't fit
 * fails validation (validateMoveinInvoices) and nothing is exported. Free-text fields (supplier
 * name, bank details) are cut to their width on purpose - see docs/integrations.md.
 */
export const MOVEIN_FIELD_WIDTHS = {
  invoiceNumber: 9,
  account: 15,
  vatId: 15,
  amount: 12,
  supplierName: 50,
  bankDetails: 50,
} as const;

export interface MoveinValidationProblem {
  invoiceId: string;
  /** Invoice number (or file name) for the message. */
  label: string;
  /** Hebrew description of the problem. */
  message: string;
}

/** Thrown by MoveinExporter.export when an invoice doesn't fit the file format. */
export class MoveinValidationError extends Error {
  constructor(public readonly problems: MoveinValidationProblem[]) {
    super(`לא ניתן לייצא ל-Move-in: ${problems.map((p) => `${p.label} - ${p.message}`).join('; ')}`);
    this.name = 'MoveinValidationError';
  }
}

function lookupCode(mappings: AccountMapping[], type: 'supplier' | 'category', key: string | null | undefined): string {
  if (!key) return '';
  const m = mappings.find((m) => m.mapping_type === type && m.key === key);
  if (m) return m.account_code;
  // Fallback to "ספקים שונים" with code 3499 if supplier is not mapped
  if (type === 'supplier') return '3499';
  return '???';
}

/** Problems that would make the Move-in line wrong (values longer than their field). Pure. */
export function validateMoveinInvoice(inv: Invoice, mappings: AccountMapping[], clientVatAccount: string): MoveinValidationProblem[] {
  const data = inv.validated_data ?? inv.extracted_data;
  if (!data) return [];
  const label = (data.invoice_number ?? '').trim() || inv.file_name || inv.id;
  const problems: MoveinValidationProblem[] = [];
  const check = (value: string, width: number, message: string) => {
    if (value.length > width) problems.push({ invoiceId: inv.id, label, message });
  };
  const W = MOVEIN_FIELD_WIDTHS;
  check((data.invoice_number ?? '').trim(), W.invoiceNumber,
    `מספר החשבונית "${(data.invoice_number ?? '').trim()}" ארוך מ-${W.invoiceNumber} תווים (שדה האסמכתא ב-Move-in). יש לקצר אותו בבדיקת החשבונית לפני הייצוא.`);
  const supplierAccount = lookupCode(mappings, 'supplier', data.supplier_name);
  check(supplierAccount === '???' ? '' : supplierAccount, W.account, `קוד חשבון הספק "${supplierAccount}" ארוך מ-${W.account} תווים`);
  const expenseAccount = lookupCode(mappings, 'category', data.expense_category);
  check(expenseAccount === '???' ? '' : expenseAccount, W.account, `קוד חשבון ההוצאה "${expenseAccount}" ארוך מ-${W.account} תווים`);
  check((data.supplier_vat_id ?? '').trim(), W.vatId, `מספר העוסק של הספק ארוך מ-${W.vatId} תווים`);
  check((clientVatAccount ?? '').trim(), W.account, `חשבון המע"מ של הלקוח ארוך מ-${W.account} תווים`);
  for (const [value, name] of [
    [data.total_amount, 'הסכום הכולל'],
    [data.amount_before_vat, 'הסכום לפני מע"מ'],
    [data.vat_amount, 'סכום המע"מ'],
  ] as const) {
    check((value ?? 0).toFixed(2), W.amount, `${name} חורג מרוחב השדה (${W.amount} תווים)`);
  }
  return problems;
}

export function validateMoveinInvoices(invoices: Invoice[], mappings: AccountMapping[], clientVatAccount: string): MoveinValidationProblem[] {
  return invoices.flatMap((inv) => validateMoveinInvoice(inv, mappings, clientVatAccount));
}

export class MoveinExporter {
  /** Throws MoveinValidationError when a value doesn't fit its field (nothing is silently cut). */
  export(invoices: Invoice[], mappings: AccountMapping[], clientVatAccount: string): Buffer {
    const problems = validateMoveinInvoices(invoices, mappings, clientVatAccount);
    if (problems.length > 0) throw new MoveinValidationError(problems);

    const lines: string[] = [];

    for (const inv of invoices) {
      const data = inv.validated_data ?? inv.extracted_data;
      if (!data) continue;

      const supplierAccount = this.lookupCode(mappings, 'supplier', data.supplier_name);
      const expenseAccount  = this.lookupCode(mappings, 'category', data.expense_category);
      const invoiceNumber   = (data.invoice_number ?? '').trim();
      const invoiceDate     = this.formatDate(data.invoice_date);
      
      const supplierName    = data.supplier_name ?? '';
      const supplierVatId   = (data.supplier_vat_id ?? '').trim();
      
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
          (clientVatAccount ?? '').trim(),
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
      this.padLeft(this.visualText(supplierName, 50), 50) + // starts at 76, length 50
      this.padLeft(supplierVatId, 15) +  // starts at 126, length 15
      this.padLeft('', 15) +             // starts at 141, length 15
      this.padLeft(clientVatAccount, 15) + // starts at 156, length 15
      this.padLeft(this.visualText(vatDescription, 15), 15) + // starts at 171, length 15
      this.padLeft(totalAmount.toFixed(2), 12) + // starts at 186, length 12
      this.padLeft('', 12) +             // starts at 198, length 12
      this.padLeft(netAmount.toFixed(2), 12) + // starts at 210, length 12
      this.padLeft(vatAmount.toFixed(2), 12) + // starts at 222, length 12
      this.padLeft('', 48) +             // starts at 234, length 48
      this.padLeft(this.visualText(bankDetails, 50), 50) // starts at 282, length 50
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

  /**
   * Free text in visual order, cut to the field width BEFORE the RTL reversal so the start of the
   * text is kept (cutting after reversing kept the end of the name).
   */
  private visualText(s: string, len: number): string {
    return toVisualHebrew(s.slice(0, len));
  }

  /** Right-aligns to the field width. Values are validated to fit (validateMoveinInvoice). */
  private padLeft(s: string, len: number): string {
    return s.slice(0, len).padStart(len, ' ');
  }

  private lookupCode(mappings: AccountMapping[], type: 'supplier' | 'category', key: string | null): string {
    return lookupCode(mappings, type, key);
  }

}
