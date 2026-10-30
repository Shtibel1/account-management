import { z } from 'zod';
import type { ApiExportPlugin, ExportInvoice, PluginContext } from '@/integrations/types';
import {
  docTypeFor,
  invoiceProblems,
  isCreditNote,
  isDraftOnly,
  normalizeVatId,
  toIcountPayload,
  type IcountConfig,
  type IcountExportPayload,
} from '@/integrations/plugins/icount/mapping';
import {
  createExpense,
  findExpense,
  findSupplier,
  getDocTypes,
  getExpenseTypes,
  getSuppliers,
  IcountApiError,
  resolveSupplier,
} from '@/integrations/plugins/icount/client';

const onOff = z.enum(['on', 'off']).optional();
const numericId = z.string().trim().regex(/^\d{1,10}$/, 'מזהה מספרי בלבד').optional();
const docType = z.string().trim().regex(/^[a-z_]{2,40}$/, 'סוג מסמך לא תקין (למשל invoice)').optional();

const configSchema: z.ZodType<IcountConfig> = z.object({
  authMode: z.enum(['token', 'login']).optional(),
  apiToken: z.string().trim().min(8, 'טוקן קצר מדי').max(4096).optional(),
  cid: z.string().trim().min(1).max(200).optional(),
  user: z.string().trim().min(1).max(200).optional(),
  pass: z.string().min(1).max(500).optional(),
  defaultExpenseTypeId: numericId,
  expenseTypeFromCategory: onOff,
  docType,
  creditDocType: docType,
  draftOnly: onOff,
}).strict().superRefine((cfg, issue) => {
  if ((cfg.authMode ?? 'token') === 'token') {
    if (!cfg.apiToken) issue.addIssue({ code: z.ZodIssueCode.custom, path: ['apiToken'], message: 'נדרש טוקן API' });
  } else {
    for (const key of ['cid', 'user', 'pass'] as const) {
      if (!cfg[key]) issue.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: 'נדרש בהתחברות עם שם משתמש וסיסמה' });
    }
  }
  if (!cfg.defaultExpenseTypeId && cfg.expenseTypeFromCategory !== 'on') {
    issue.addIssue({ code: z.ZodIssueCode.custom, path: ['defaultExpenseTypeId'], message: 'נדרש מזהה סוג הוצאה (או שימוש בקוד הקטגוריה)' });
  }
});

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * What findExisting learned about an invoice, reused by exportInvoice in the same run: the export runner
 * calls findExisting and then exportInvoice with the same per-invoice context, so the supplier lookup
 * and expense search are not repeated. Keyed by the context's http client object (one per invoice and
 * run) so nothing outlives the run.
 */
interface LookupMemo { supplierId: number | null; expenseFound: boolean }
const lookupMemo = new WeakMap<object, Map<string, LookupMemo>>();

function memoFor(ctx: PluginContext<IcountConfig>, invoiceId: string): LookupMemo | undefined {
  return lookupMemo.get(ctx.http)?.get(invoiceId);
}

function remember(ctx: PluginContext<IcountConfig>, invoiceId: string, memo: LookupMemo): void {
  let byInvoice = lookupMemo.get(ctx.http);
  if (!byInvoice) lookupMemo.set(ctx.http, (byInvoice = new Map()));
  byInvoice.set(invoiceId, memo);
}

/** The invoice's expense in iCount (lookup only: never creates the supplier). */
async function lookupExisting(ctx: PluginContext<IcountConfig>, invoice: ExportInvoice): Promise<string | null> {
  const d = invoice.data;
  const docnum = d.invoice_number?.trim();
  if (!docnum) return null;
  const supplierId = await findSupplier(ctx, { name: d.supplier_name?.trim() || null, vat_id: normalizeVatId(d.supplier_vat_id) });
  const expenseId = supplierId === null ? null : await findExpense(ctx, supplierId, docTypeFor(ctx.config, isCreditNote(invoice)), docnum);
  remember(ctx, invoice.id, { supplierId, expenseFound: expenseId !== null });
  return expenseId;
}

/**
 * iCount (API v3): each approved invoice becomes an expense (expense/create) of the supplier, with the
 * amount before VAT and the VAT entered manually (adv_expense), the ITA allocation number, and - by
 * default - as a DRAFT (no public sandbox exists, so drafts are the safety net).
 */
export const icountPlugin: ApiExportPlugin<IcountConfig, IcountExportPayload> = {
  id: 'icount',
  displayName: 'iCount',
  description: 'יצירת הוצאה ב-iCount לכל חשבונית מאושרת (ספק, סוג הוצאה, סכום לפני מע"מ ומע"מ, מספר הקצאה). ברירת המחדל: טיוטה בלבד.',
  kind: 'api',
  configSchema,
  configFields: [
    {
      key: 'authMode', label: 'שיטת התחברות', type: 'select', secret: false, required: false,
      options: [{ value: 'token', label: 'טוקן API (מומלץ)' }, { value: 'login', label: 'מזהה חברה, משתמש וסיסמה' }],
      help: 'ברירת מחדל: טוקן API.',
    },
    { key: 'apiToken', label: 'טוקן API', type: 'password', secret: true, required: false, help: 'נוצר ב-iCount: הגדרות > API. נשלח בכותרת Authorization.' },
    { key: 'cid', label: 'מזהה חברה (cid)', type: 'text', secret: false, required: false, help: 'רק בהתחברות עם משתמש וסיסמה.' },
    { key: 'user', label: 'שם משתמש', type: 'text', secret: false, required: false },
    { key: 'pass', label: 'סיסמה', type: 'password', secret: true, required: false },
    {
      key: 'defaultExpenseTypeId', label: 'מזהה סוג הוצאה ברירת מחדל', type: 'number', secret: false, required: false,
      help: 'expense_type_id מ-iCount (רשימת סוגי ההוצאה מוצגת ב"בדוק חיבור").',
    },
    {
      key: 'expenseTypeFromCategory', label: 'קוד החשבון של הקטגוריה = סוג הוצאה ב-iCount', type: 'select', secret: false, required: false,
      options: [{ value: 'off', label: 'לא (ברירת מחדל)' }, { value: 'on', label: 'כן' }],
      help: 'כשמופעל, קוד החשבון של הקטגוריה במיפוי החשבונות משמש כ-expense_type_id.',
    },
    { key: 'docType', label: 'סוג מסמך לחשבונית', type: 'text', secret: false, required: false, placeholder: 'invoice' },
    { key: 'creditDocType', label: 'סוג מסמך להודעת זיכוי', type: 'text', secret: false, required: false, placeholder: 'refund' },
    {
      key: 'draftOnly', label: 'טיוטות בלבד', type: 'select', secret: false, required: false,
      options: [{ value: 'on', label: 'כן - ליצור טיוטות (ברירת מחדל, מומלץ)' }, { value: 'off', label: 'לא - ליצור הוצאות סופיות' }],
      help: 'ל-iCount אין סביבת בדיקות: כברירת מחדל ההוצאות נוצרות כטיוטה לאישור ב-iCount.',
    },
  ],
  capabilities: { attachPdf: false, allocationNumber: true, duplicateCheck: true, sandbox: false },

  async testConnection(ctx) {
    if (ctx.environment !== 'production') return { ok: false, message: 'ל-iCount אין סביבת בדיקות. בחרו סביבת ייצור.' };
    try {
      const docTypes = await getDocTypes(ctx);
      const types = await getExpenseTypes(ctx, 'test_connection');
      const notes: string[] = [];
      for (const dt of [docTypeFor(ctx.config, false), docTypeFor(ctx.config, true)]) {
        if (docTypes.length > 0 && !docTypes.includes(dt)) notes.push(`סוג המסמך "${dt}" לא קיים (קיימים: ${docTypes.join(', ')})`);
      }
      const def = ctx.config.defaultExpenseTypeId?.trim();
      if (def && !types.some((t) => String(t.expense_type_id) === def)) notes.push(`סוג ההוצאה ${def} לא נמצא`);
      const list = types.slice(0, 15).map((t) => `${t.expense_type_id}=${t.expense_type_name}`).join(', ');
      const mode = isDraftOnly(ctx.config) ? 'טיוטות בלבד' : 'הוצאות סופיות';
      if (notes.length) return { ok: false, message: `החיבור תקין, אבל: ${notes.join('; ')}.${list ? ` סוגי הוצאה: ${list}` : ''}` };
      return { ok: true, message: `החיבור ל-iCount תקין (${mode}).${list ? ` סוגי הוצאה: ${list}` : ''}` };
    } catch (err) {
      return { ok: false, message: err instanceof IcountApiError ? err.message : `החיבור נכשל: ${errorMessage(err)}` };
    }
  },

  validateInvoice(invoice) {
    return invoiceProblems(invoice);
  },

  buildPayload(ctx, invoice, mapping) {
    return toIcountPayload(invoice, mapping, ctx.config);
  },

  async exportInvoice(ctx, invoice, mapping) {
    if (ctx.environment !== 'production') throw new Error('ל-iCount אין סביבת בדיקות');
    const payload = toIcountPayload(invoice, mapping, ctx.config);
    if (payload.problems.length) throw new Error(`לא ניתן לייצא ל-iCount: ${payload.problems.join(', ')}`);
    const { expense } = payload;

    // findExisting (called just before by the export runner) already looked the supplier and the
    // document up and found no document: reuse that instead of asking again.
    const memo = memoFor(ctx, invoice.id);
    const checked = memo !== undefined && !memo.expenseFound;
    const supplierId = checked && memo.supplierId !== null
      ? memo.supplierId
      : await resolveSupplier(ctx, payload.supplier, checked);

    // Idempotency in the target: the same supplier document may already exist (an earlier attempt,
    // or entered by hand in iCount). A supplier created just now has no documents yet.
    if (!checked) {
      const existing = await findExpense(ctx, supplierId, expense.expense_doctype, expense.expense_docnum);
      if (existing) {
        ctx.logger.info('icount: expense already exists, linking it', { invoiceId: invoice.id, expenseId: existing });
        return { externalId: existing };
      }
    }

    try {
      const expenseId = await createExpense(ctx, { ...expense, supplier_id: supplierId });
      return { externalId: expenseId };
    } catch (err) {
      if (err instanceof IcountApiError && err.reason === 'expense_already_exists') {
        const found = await findExpense(ctx, supplierId, expense.expense_doctype, expense.expense_docnum);
        if (found) return { externalId: found };
        throw new Error(`המסמך ${expense.expense_docnum} כבר קיים ב-iCount (expense_already_exists) אך לא אותר בחיפוש. בדקו ב-iCount.`);
      }
      throw err;
    }
  },

  async findExisting(ctx, invoice) {
    const id = await lookupExisting(ctx, invoice);
    return id ? { externalId: id } : null;
  },

  async listSuppliers(ctx) {
    const list = await getSuppliers(ctx, {}, 'list_suppliers');
    return list.map((s) => ({ id: String(s.supplier_id), name: s.supplier_name, ...(s.vat_id ? { code: s.vat_id } : {}) }));
  },

  async listAccounts(ctx) {
    const types = await getExpenseTypes(ctx);
    return types.map((t) => ({ id: String(t.expense_type_id), name: t.expense_type_name, code: String(t.expense_type_id) }));
  },
};
