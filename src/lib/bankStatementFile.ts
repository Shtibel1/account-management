import type { StatementCell } from '@/shared/bankStatement';
import { decodeStatementText } from '@/shared/bankStatement';

/**
 * Reads the first non-empty sheet of a statement upload (CSV / XLS / XLSX, including the HTML-table
 * ".xls" some Israeli banks export) into raw rows. Values are kept raw (no date/number guessing by
 * SheetJS - it would read 05/10 as May 10th); bankStatement.ts normalizes them.
 */
export async function readStatementFile(file: File): Promise<StatementCell[][]> {
  const XLSX = await import('xlsx');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const isText = /\.(csv|tsv|txt)$/i.test(file.name) || file.type === 'text/csv' || file.type === 'text/plain';

  const workbook = isText
    ? XLSX.read(decodeStatementText(bytes), { type: 'string', raw: true })
    : XLSX.read(bytes, { type: 'array', raw: true });

  for (const name of workbook.SheetNames) {
    const rows = XLSX.utils.sheet_to_json<StatementCell[]>(workbook.Sheets[name], {
      header: 1,
      raw: true,
      defval: '',
      blankrows: true,
    });
    if (rows.some((r) => r.some((c) => c !== '' && c != null))) return rows;
  }
  throw new Error('הקובץ ריק');
}
