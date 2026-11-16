import { z } from 'zod';
import type { ApiExportPlugin } from '@/integrations/types';
import {
  lookupWindow,
  matchExistingDocument,
  sumitSettings,
  toSumitExpense,
  validateForSumit,
  type SumitConfig,
  type SumitExpensePayload,
} from '@/integrations/plugins/sumit/mapping';
import { ensureExtension } from '@/lib/ingestHelpers';
import { addExpense, getVatRate, listExpenseDocuments, SumitApiError } from '@/integrations/plugins/sumit/client';

const configSchema: z.ZodType<SumitConfig> = z.object({
  companyId: z.string().trim().regex(/^\d{1,15}$/, 'מזהה חברה (CompanyID) חייב להיות מספר'),
  apiKey: z.string().trim().min(8, 'מפתח API קצר מדי').max(4096),
  documentMode: z.enum(['draft', 'final']).optional(),
  amountMode: z.enum(['gross', 'net']).optional(),
  itemMatch: z.enum(['name', 'externalId', 'id']).optional(),
  defaultItem: z.string().trim().min(1).max(200).optional(),
  attachFile: z.enum(['yes', 'no']).optional(),
}).strict();

/** Base64 of the file bytes (Buffer is fine: server-side only). */
function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

/**
 * SUMIT (סאמיט): each approved invoice becomes an expense document (POST
 * /accounting/documents/addexpense/), with the original PDF attached and, by default, saved as a DRAFT.
 * No sandbox exists at SUMIT, hence capabilities.sandbox = false. See README.md in this folder.
 */
export const sumitPlugin: ApiExportPlugin<SumitConfig, SumitExpensePayload> = {
  id: 'sumit',
  displayName: 'SUMIT',
  description: 'יצירת מסמך הוצאה ב-SUMIT לכל חשבונית מאושרת, כולל צירוף קובץ החשבונית. ברירת המחדל: שמירה כטיוטה.',
  kind: 'api',
  configSchema,
  configFields: [
    { key: 'companyId', label: 'מזהה חברה (CompanyID)', type: 'text', secret: false, required: true, placeholder: '12345678', help: 'ב-SUMIT: ניהול > פרטי חברה > API.' },
    { key: 'apiKey', label: 'מפתח API', type: 'password', secret: true, required: true, help: 'מפתח ה-API של החברה ב-SUMIT. נשמר מוצפן.' },
    {
      key: 'documentMode', label: 'אופן שמירת המסמך', type: 'select', secret: false, required: false,
      help: 'מומלץ להשאיר טיוטה ולהפיק את המסמך ב-SUMIT לאחר בדיקה.',
      options: [{ value: 'draft', label: 'טיוטה (מומלץ)' }, { value: 'final', label: 'מסמך סופי' }],
    },
    {
      key: 'amountMode', label: 'סכום השורה', type: 'select', secret: false, required: false,
      help: 'SUMIT מקבל סכום אחד לשורה ומחשב את המע"מ בעצמו. ברירת מחדל: כולל מע"מ.',
      options: [{ value: 'gross', label: 'כולל מע"מ (סה"כ החשבונית)' }, { value: 'net', label: 'לפני מע"מ' }],
    },
    {
      key: 'itemMatch', label: 'זיהוי סעיף ההוצאה', type: 'select', secret: false, required: false,
      help: 'כיצד קוד החשבון מהמיפוי מזוהה ב-SUMIT.',
      options: [
        { value: 'name', label: 'לפי שם הסעיף' },
        { value: 'externalId', label: 'לפי מזהה חיצוני' },
        { value: 'id', label: 'לפי מזהה SUMIT (מספר)' },
      ],
    },
    { key: 'defaultItem', label: 'סעיף הוצאה ברירת מחדל', type: 'text', secret: false, required: false, help: 'משמש לחשבוניות ללא קטגוריה.' },
    {
      key: 'attachFile', label: 'צירוף קובץ החשבונית', type: 'select', secret: false, required: false,
      options: [{ value: 'yes', label: 'כן' }, { value: 'no', label: 'לא' }],
    },
  ],
  capabilities: { attachPdf: true, allocationNumber: true, duplicateCheck: true, sandbox: false },

  async testConnection(ctx) {
    try {
      const rate = await getVatRate(ctx);
      const pct = rate === null ? null : rate < 1 ? Math.round(rate * 10000) / 100 : rate;
      return { ok: true, message: pct === null ? 'החיבור ל-SUMIT תקין.' : `החיבור ל-SUMIT תקין (שיעור מע"מ: ${pct}%).` };
    } catch (err) {
      if (err instanceof SumitApiError) return { ok: false, message: err.message };
      throw err;
    }
  },

  validateInvoice(invoice, mapping) {
    // No config here: the expense-item checks run in exportInvoice (before any write).
    return validateForSumit(invoice, mapping, null);
  },

  buildPayload(ctx, invoice, mapping) {
    return toSumitExpense(invoice, mapping, sumitSettings(ctx.config));
  },

  async exportInvoice(ctx, invoice, mapping) {
    const settings = sumitSettings(ctx.config);
    const problems = validateForSumit(invoice, mapping, settings);
    if (problems.length > 0) throw new Error(`לא ניתן לייצא ל-SUMIT: ${problems.join(', ')}`);
    const payload = toSumitExpense(invoice, mapping, settings);
    if (settings.attachFile) {
      if (!ctx.files) throw new Error('צירוף קובץ החשבונית אינו זמין');
      const file = await ctx.files.load(invoice);
      payload.ExpenseFile = toBase64(file.bytes);
      // The extension must match the real file type (SUMIT keeps the name as given).
      payload.ExpenseFilename = ensureExtension(file.fileName, file.contentType);
    }
    const documentId = await addExpense(ctx, payload);
    return { externalId: String(documentId) };
  },

  async findExisting(ctx, invoice) {
    const date = invoice.data.invoice_date;
    // Without a date the lookup is impossible; validateInvoice blocks such invoices before this.
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    const docs = await listExpenseDocuments(ctx, lookupWindow(date));
    const found = matchExistingDocument(invoice, docs);
    if (!found || typeof found.DocumentID !== 'number') return null;
    // DocumentDownloadURL is not kept: SUMIT serves the original only on the first visit.
    return { externalId: String(found.DocumentID) };
  },
};
