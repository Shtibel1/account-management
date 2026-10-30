import { z } from 'zod';
import type { FileExportPlugin } from '@/integrations/types';
import { toExcelRows } from '@/integrations/plugins/excel/mapping';
import { writeExcelFile } from '@/integrations/plugins/excel/client';

const configSchema = z.object({}).strict();

/** Excel summary of the exported invoices with their account codes. */
export const excelPlugin: FileExportPlugin<z.infer<typeof configSchema>> = {
  id: 'excel',
  displayName: 'Excel (קובץ)',
  description: 'גיליון Excel עם פרטי החשבוניות וקודי החשבונות, לקליטה ידנית או לבקרה.',
  kind: 'file',
  configSchema,
  configFields: [],
  capabilities: { attachPdf: false, allocationNumber: true, duplicateCheck: false, sandbox: false },

  async testConnection() {
    return { ok: true, message: 'ייצוא לקובץ - אין צורך בחיבור.' };
  },

  buildFile(_ctx, items) {
    const today = new Date().toISOString().slice(0, 10);
    return {
      fileName: `invoices-${today}.xlsx`,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      body: writeExcelFile(toExcelRows(items)),
      invoiceIds: items.map((i) => i.invoice.id),
    };
  },
};
