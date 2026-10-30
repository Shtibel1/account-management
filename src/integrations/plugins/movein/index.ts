import { z } from 'zod';
import type { FileExportPlugin } from '@/integrations/types';
import { toMoveinInput } from '@/integrations/plugins/movein/mapping';
import { writeMoveinFile } from '@/integrations/plugins/movein/client';

const configSchema = z.object({}).strict();

/** Move-in import file (movein.dat) - wraps src/lib/exporters/movein.ts without changing its output. */
export const moveinPlugin: FileExportPlugin<z.infer<typeof configSchema>> = {
  id: 'movein',
  displayName: 'Move-in (קובץ)',
  description: 'קובץ movein.dat לקליטה בתוכנת הנהלת החשבונות (חשבשבת / Move-in).',
  kind: 'file',
  configSchema,
  configFields: [],
  capabilities: { attachPdf: false, allocationNumber: false, duplicateCheck: false, sandbox: false },

  async testConnection() {
    return { ok: true, message: 'ייצוא לקובץ - אין צורך בחיבור.' };
  },

  buildFile(_ctx, items) {
    const withData = items.filter((i) => i.invoice.raw.validated_data ?? i.invoice.raw.extracted_data);
    return {
      fileName: 'movein.dat',
      contentType: 'text/plain; charset=windows-1255',
      body: writeMoveinFile(toMoveinInput(withData)),
      invoiceIds: withData.map((i) => i.invoice.id),
    };
  },
};
