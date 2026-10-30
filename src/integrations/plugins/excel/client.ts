import * as XLSX from 'xlsx';
import type { ExcelCell } from '@/integrations/plugins/excel/mapping';

/** File "client": writes an RTL .xlsx workbook (server side, no network). */
export function writeExcelFile(rows: ExcelCell[][]): Buffer {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [
    { wch: 14 }, { wch: 12 }, { wch: 28 }, { wch: 14 }, { wch: 14 }, { wch: 18 },
    { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 12 }, { wch: 10 }, { wch: 12 }, { wch: 30 },
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'חשבוניות');
  wb.Workbook = { Views: [{ RTL: true }] };
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}
