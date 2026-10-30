/** 1234.5 -> "1,234.50" (sign kept, so debits show as "-1,234.50"). */
export function formatAmount(amount: number): string {
  return amount.toLocaleString('he-IL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
