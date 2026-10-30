import * as XLSX from 'xlsx';
import { EXCEL_DATE_FORMAT, isExcelDateCell, type ExcelCell } from '@/integrations/plugins/excel/mapping';

/** File "client": writes an RTL .xlsx workbook (server side, no network). */
export function writeExcelFile(rows: ExcelCell[][]): Buffer {
  // Date cells are written as numbers (Excel serial dates) and then given the dd/mm/yyyy format, so
  // Excel sees real dates (sortable / filterable) that display as 07/06/2026 (QA N19).
  const ws = XLSX.utils.aoa_to_sheet(rows.map((row) => row.map((cell) => (isExcelDateCell(cell) ? cell.serial : cell))));
  rows.forEach((row, r) => row.forEach((cell, c) => {
    if (!isExcelDateCell(cell)) return;
    const ref = XLSX.utils.encode_cell({ r, c });
    ws[ref] = { t: 'n', v: cell.serial, z: EXCEL_DATE_FORMAT };
  }));
  ws['!cols'] = [
    { wch: 14 }, { wch: 12 }, { wch: 28 }, { wch: 14 }, { wch: 14 }, { wch: 18 },
    { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 12 }, { wch: 10 }, { wch: 12 }, { wch: 30 },
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'חשבוניות');
  wb.Workbook = { Views: [{ RTL: true }] };
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}
