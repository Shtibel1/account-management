import type { AccountMapping, Invoice } from '@/shared/types';
import { toVisualHebrew, encodeWindows1255 } from '@/utils/encoding';
import { exportDataProblems, MOVEIN_INVOICE_NUMBER_WIDTH } from '@/shared/exportData';

/**
 * Field widths of the Move-in fixed-width line (332 characters, see buildLine). Identifying fields
 * (reference, account codes, VAT ids, amounts) are never cut: an invoice whose value doesn't fit
 * fails validation (validateMoveinInvoices) and nothing is exported. Free-text fields (supplier
 * name, bank details) are cut to their width on purpose - see docs/integrations.md.
 */
export const MOVEIN_FIELD_WIDTHS = {
  invoiceNumber: MOVEIN_INVOICE_NUMBER_WIDTH,
  account: 15,
  vatId: 15,
  amount: 12,
  supplierName: 50,
  bankDetails: 50,
} as const;

/** Characters (= Windows-1255 bytes) of one Move-in record, without the CRLF. */
export const MOVEIN_LINE_LENGTH = 332;

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

/**
 * A value as it may be written into the fixed-width Move-in line (QA-MV B1). Every record is ONE
 * CRLF-terminated line, so a CR / LF / TAB (or any other control character) inside a value - e.g. a
 * supplier name the AI read over two lines, or pasted text - would split the record and shift every
 * following field. Control and line / paragraph separators become a space, invisible bidi marks and
 * Hebrew points / cantillation (not in the 332-byte layout, they would turn into "?") are dropped, the
 * Hebrew maqaf becomes "-", and runs of spaces collapse. Pure.
 */
export function moveinText(value: string | null | undefined): string {
  if (typeof value !== 'string' || value === '') return '';
  return value
    .replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g, ' ')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF\u061C]/g, '')
    .replace(/[\u0591-\u05BD\u05BF-\u05C7]/g, '')
    .replace(/\u05BE/g, '-')
    .replace(/ {2,}/g, ' ')
    .trim();
}

/**
 * Bank details for the 50-character free-text field: "<bank> <branch name> מס' סניף : <code> מספר
 * חשבון : <account>". When that is too long the NAMES are dropped first (branch name, then bank
 * name), so the branch code and account number are never cut in the middle (QA-MV B2: a long
 * branch name used to leave "מספר חשבון : 1" of account 12345/67).
 */
export function moveinBankDetails(
  data: { bank_name?: string | null; bank_branch_name?: string | null; bank_branch_code?: string | null; bank_account?: string | null },
  width: number = MOVEIN_FIELD_WIDTHS.bankDetails
): string {
  const bank = moveinText(data.bank_name);
  const branchName = moveinText(data.bank_branch_name);
  const code = moveinText(data.bank_branch_code);
  const account = moveinText(data.bank_account);
  const tail: string[] = [];
  if (code) tail.push(`מס' סניף : ${code}`);
  if (account) tail.push(`מספר חשבון : ${account}`);
  const candidates = [[bank, branchName, ...tail], [bank, ...tail], tail];
  for (const parts of candidates) {
    const text = parts.filter(Boolean).join(' ');
    if (text.length <= width) return text;
  }
  // Even code + account alone don't fit: keep the account number whole, shorten the labels.
  const short = [code && `סניף ${code}`, account && `חשבון ${account}`].filter(Boolean).join(' ');
  return short.length <= width ? short : (account || short).slice(0, width);
}

function lookupCode(mappings: AccountMapping[], type: 'supplier' | 'category', key: string | null | undefined): string {
  if (!key) return '';
  const m = mappings.find((m) => m.mapping_type === type && m.key === key);
  if (m) return m.account_code;
  // Fallback to "ספקים שונים" with code 3499 if supplier is not mapped
  if (type === 'supplier') return '3499';
  return '???';
}

/**
 * Problems that would make the Move-in line wrong: invalid stored data (QA #12: e.g. an amount
 * "abc" or a date "31/02/2026" from before approval validation existed) or values longer than their
 * field. Pure; never throws whatever the stored JSON holds.
 */
export function validateMoveinInvoice(inv: Invoice, mappings: AccountMapping[], clientVatAccount: string): MoveinValidationProblem[] {
  const data = inv.validated_data ?? inv.extracted_data;
  const rawNumber = data && typeof data.invoice_number === 'string' ? data.invoice_number.trim() : '';
  const label = rawNumber || inv.file_name || inv.id;
  const dataProblems = exportDataProblems(data);
  if (!data || dataProblems.length > 0) {
    return dataProblems.map((message) => ({ invoiceId: inv.id, label, message }));
  }
  const problems: MoveinValidationProblem[] = [];
  const check = (value: string, width: number, message: string) => {
    if (value.length > width) problems.push({ invoiceId: inv.id, label, message });
  };
  const W = MOVEIN_FIELD_WIDTHS;
  const invoiceNumber = moveinText(data.invoice_number);
  check(invoiceNumber, W.invoiceNumber,
    `מספר החשבונית "${invoiceNumber}" ארוך מ-${W.invoiceNumber} תווים (שדה האסמכתא ב-Move-in). יש לקצר אותו בבדיקת החשבונית לפני הייצוא.`);
  const supplierAccount = lookupCode(mappings, 'supplier', data.supplier_name);
  check(supplierAccount === '???' ? '' : moveinText(supplierAccount), W.account, `קוד חשבון הספק "${supplierAccount}" ארוך מ-${W.account} תווים`);
  const expenseAccount = lookupCode(mappings, 'category', data.expense_category);
  check(expenseAccount === '???' ? '' : moveinText(expenseAccount), W.account, `קוד חשבון ההוצאה "${expenseAccount}" ארוך מ-${W.account} תווים`);
  check(moveinText(data.supplier_vat_id), W.vatId, `מספר העוסק של הספק ארוך מ-${W.vatId} תווים`);
  check(moveinText(clientVatAccount), W.account, `חשבון המע"מ של הלקוח ארוך מ-${W.account} תווים`);
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
      const invoiceNumber   = moveinText(data.invoice_number);
      const invoiceDate     = this.formatDate(data.invoice_date);
      
      const supplierName    = moveinText(data.supplier_name);
      const supplierVatId   = moveinText(data.supplier_vat_id);
      
      const totalAmount     = data.total_amount ?? 0;
      const netAmount       = data.amount_before_vat ?? 0;
      const vatAmount       = data.vat_amount ?? 0;

      // "<bank> <branch name> מס' סניף : <code> מספר חשבון : <account>", names dropped first when too long
      const bankDetails = moveinBankDetails(data);

      lines.push(
        this.buildLine(
          invoiceNumber,
          invoiceDate,
          supplierAccount === '???' ? '' : moveinText(supplierAccount),
          expenseAccount === '???' ? '' : moveinText(expenseAccount),
          supplierName,
          supplierVatId,
          moveinText(clientVatAccount),
          totalAmount,
          netAmount,
          vatAmount,
          bankDetails
        )
      );
    }

    // Defensive (QA-MV B1): every record must be exactly one 332-character line.
    for (const line of lines) {
      if (line.length !== MOVEIN_LINE_LENGTH || /[\r\n]/.test(line)) {
        throw new Error(`Move-in line is ${line.length} characters (expected ${MOVEIN_LINE_LENGTH}) or contains a line break`);
      }
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
