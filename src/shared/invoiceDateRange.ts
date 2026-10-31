import type { Invoice } from '@/shared/types';

/** Invoice date (validated, else extracted; YYYY-MM-DD) within [from, to]; an empty bound is open. */
export function inDateRange(inv: Pick<Invoice, 'validated_data' | 'extracted_data'>, from: string, to: string): boolean {
  if (!from && !to) return true;
  const date = (inv.validated_data ?? inv.extracted_data)?.invoice_date;
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  return (!from || date >= from) && (!to || date <= to);
}
