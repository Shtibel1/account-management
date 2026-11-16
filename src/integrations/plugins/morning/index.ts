import { z } from 'zod';
import type { ApiExportPlugin, ExistingDocument, ExportInvoice, PluginContext } from '@/integrations/types';
import { IntegrationHttpError } from '@/integrations/http';
import {
  isSameExpense,
  morningDocumentType,
  morningValidationProblems,
  toMorningExpense,
  toMorningSearch,
  type MappingOptions,
  type MorningDocumentType,
  type MorningExpenseRequest,
} from '@/integrations/plugins/morning/mapping';
import {
  createExpense,
  getAccessToken,
  getUploadTarget,
  MorningApiError,
  searchExpenses,
  uploadFile,
  type MorningConfig,
} from '@/integrations/plugins/morning/client';

const configSchema: z.ZodType<MorningConfig> = z.object({
  clientId: z.string().trim().min(4, 'מזהה API קצר מדי').max(512),
  clientSecret: z.string().trim().min(8, 'סוד API קצר מדי').max(4096),
  defaultDocumentType: z.enum(['305', '320']).optional(),
  attachPdf: z.enum(['yes', 'no']).optional(),
}).strict();

/** Search pages checked for an existing expense (pageSize 50 each). */
const MAX_SEARCH_PAGES = 3;

function options(ctx: PluginContext<MorningConfig>): MappingOptions {
  return { defaultDocumentType: ctx.config.defaultDocumentType === '320' ? 320 : 305 };
}

async function findExpense(
  ctx: PluginContext<MorningConfig>,
  invoice: ExportInvoice,
  documentType: MorningDocumentType
): Promise<ExistingDocument | null> {
  for (let page = 1; page <= MAX_SEARCH_PAGES; page++) {
    const search = toMorningSearch(invoice, page);
    if (!search) return null;
    const res = await searchExpenses(ctx, search);
    const items = Array.isArray(res.items) ? res.items : [];
    const hit = items.find((item) => isSameExpense(item, invoice, documentType));
    if (hit?.id) return { externalId: hit.id };
    const pages = typeof res.pages === 'number' ? res.pages : items.length < search.pageSize ? page : page + 1;
    if (page >= pages || items.length === 0) return null;
  }
  return null;
}

/** Attaches the stored PDF to the created expense. Never throws: the expense already exists. */
async function attachPdf(ctx: PluginContext<MorningConfig>, invoice: ExportInvoice, expenseId: string): Promise<void> {
  const started = Date.now();
  const fail = async (errorCode: string, errorMessage: string) => {
    ctx.logger.warn('morning: PDF not attached', { invoiceId: invoice.id, expenseId, errorCode, errorMessage });
    await ctx.logger.record({
      operation: 'attach_pdf', outcome: 'error', invoiceId: invoice.id, durationMs: Date.now() - started,
      errorCode, errorMessage: `ההוצאה נוצרה אך הקובץ לא צורף: ${errorMessage}`,
    });
  };
  if (!ctx.files) return fail('no_file_reader', 'אין גישה לקובץ החשבונית');
  try {
    const file = await ctx.files.read(invoice);
    if (!file) return fail('file_unavailable', 'קובץ החשבונית לא נמצא באחסון');
    const target = await getUploadTarget(ctx, expenseId);
    if (target.maxFileSize !== null && file.bytes.length > target.maxFileSize) {
      return fail('file_too_large', `הקובץ גדול מהמותר (${target.maxFileSize} בתים)`);
    }
    await uploadFile(ctx, target, file);
    await ctx.logger.record({
      operation: 'attach_pdf', outcome: 'ok', invoiceId: invoice.id, durationMs: Date.now() - started,
      details: { expenseId, bytes: file.bytes.length, contentType: file.contentType },
    });
  } catch (err) {
    const code = err instanceof MorningApiError || err instanceof IntegrationHttpError ? err.code : 'error';
    await fail(code, err instanceof Error ? err.message : String(err));
  }
}

function connectionError(err: unknown): string {
  if (err instanceof MorningApiError) return err.message;
  if (err instanceof IntegrationHttpError) return `לא ניתן להתחבר למורנינג: ${err.message}`;
  return 'החיבור למורנינג נכשל';
}

/**
 * Morning (Green Invoice, חשבונית ירוקה) expenses API: each approved invoice becomes an expense
 * (POST /expenses) with supplier, accounting classification, VAT split and allocation number; the
 * stored PDF is attached through the presigned upload. Existing expenses (same number + supplier)
 * are looked up first, so a repeated export never creates a duplicate.
 */
export const morningPlugin: ApiExportPlugin<MorningConfig, MorningExpenseRequest> = {
  id: 'morning',
  displayName: 'מורנינג (חשבונית ירוקה)',
  description: 'יצירת הוצאה במורנינג לכל חשבונית מאושרת, כולל ספק, סיווג חשבונאי, מע"מ, מספר הקצאה וצירוף הקובץ.',
  kind: 'api',
  configSchema,
  configFields: [
    { key: 'clientId', label: 'מזהה מפתח API (Client ID)', type: 'text', secret: true, required: true, help: 'במורנינג: הגדרות > כלים למפתחים > מפתחות API.' },
    { key: 'clientSecret', label: 'סוד מפתח API (Client Secret)', type: 'password', secret: true, required: true },
    {
      key: 'defaultDocumentType', label: 'סוג מסמך ברירת מחדל', type: 'select', secret: false, required: false,
      help: 'כשלא ניתן לזהות מהמסמך. חשבונית זיכוי מזוהה אוטומטית (סכום שלילי).',
      options: [{ value: '305', label: 'חשבונית מס (305)' }, { value: '320', label: 'חשבונית מס / קבלה (320)' }],
    },
    {
      key: 'attachPdf', label: 'צירוף קובץ החשבונית', type: 'select', secret: false, required: false,
      options: [{ value: 'yes', label: 'כן' }, { value: 'no', label: 'לא' }],
    },
  ],
  capabilities: { attachPdf: true, allocationNumber: true, duplicateCheck: true, sandbox: true },

  async testConnection(ctx) {
    try {
      await getAccessToken(ctx, true);
      await searchExpenses(ctx, { page: 1, pageSize: 1 }, 'test_connection');
      return { ok: true, message: `החיבור למורנינג תקין (${ctx.environment === 'sandbox' ? 'סביבת בדיקות' : 'סביבת ייצור'}).` };
    } catch (err) {
      return { ok: false, message: connectionError(err) };
    }
  },

  validateInvoice(invoice, mapping) {
    return morningValidationProblems(invoice, mapping);
  },

  buildPayload(ctx, invoice, mapping) {
    return toMorningExpense(invoice, mapping, options(ctx));
  },

  async findExisting(ctx, invoice) {
    return findExpense(ctx, invoice, morningDocumentType(invoice, options(ctx)));
  },

  async exportInvoice(ctx, invoice, mapping) {
    const payload = toMorningExpense(invoice, mapping, options(ctx));
    // Duplicate check before every create (also on a first export: the document may have been
    // entered in Morning by hand or by another tool).
    const existing = await findExpense(ctx, invoice, payload.documentType);
    if (existing) {
      ctx.logger.info('morning: expense already exists, linked', { invoiceId: invoice.id, expenseId: existing.externalId });
      return existing;
    }
    const created = await createExpense(ctx, payload);
    const expenseId = created.id as string;
    if (ctx.config.attachPdf !== 'no') await attachPdf(ctx, invoice, expenseId);
    return { externalId: expenseId };
  },
};
