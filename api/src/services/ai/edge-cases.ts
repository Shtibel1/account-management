import type { ExtractedData } from '@invoice/shared-types';

export interface EdgeCaseResult {
  data: ExtractedData;
  warnings: string[];   // הודעות למשתמש בממשק
  corrected: boolean;   // האם נעשה תיקון אוטומטי
}

export interface EdgeCaseHandler {
  name: string;
  description: string;
  detect(data: ExtractedData): boolean;
  handle(data: ExtractedData): Partial<ExtractedData> & { warning?: string };
}

// ─── Handlers ────────────────────────────────────────────────────────────────

/**
 * כאשר before_vat + vat ≠ total, מנסה לחשב before_vat = total - vat
 * טיפוסי ב: קבלות שמציגות "אמ"מ" (פטור) כ"לפני מע"מ"
 */
const VatAutoCorrect: EdgeCaseHandler = {
  name: 'VAT_AUTO_CORRECT',
  description: 'חישוב אוטומטי of לפני מע"מ מתוך סה"כ - מע"מ',
  detect: (data) => {
    const { amount_before_vat: b, vat_amount: v, total_amount: t } = data;
    if (b == null || v == null || t == null) return false;
    return Math.abs((b + v) - t) > 1;
  },
  handle: (data) => {
    const { vat_amount: v, total_amount: t } = data;
    if (v == null || t == null) return {};
    const corrected = Math.round((t - v) * 100) / 100;
    return {
      amount_before_vat: corrected,
      warning: `סכום לפני מע"מ תוקן אוטומטית ל-₪${corrected} (= סה"כ - מע"מ)`,
    };
  },
};

/**
 * עוסק פטור — אין מע"מ כלל, total = before_vat
 */
const ExemptSupplier: EdgeCaseHandler = {
  name: 'EXEMPT_SUPPLIER',
  description: 'ספק עוסק פטור — ללא מע"מ',
  detect: (data) => {
    const { vat_amount: v, total_amount: t } = data;
    return (v === 0 || v == null) && t != null && t > 0;
  },
  handle: (data) => ({
    vat_amount: 0,
    amount_before_vat: data.total_amount,
    warning: 'נראה שמדובר בעוסק פטור ממע"מ — אנא ודא',
  }),
};

/**
 * חשבונית זיכוי — סכום שלילי
 */
const CreditNote: EdgeCaseHandler = {
  name: 'CREDIT_NOTE',
  description: 'חשבונית זיכוי עם סכום שלילי',
  detect: (data) => (data.total_amount ?? 0) < 0,
  handle: (_data) => ({
    warning: 'זוהתה חשבונית זיכוי (סכום שלילי) — בדוק שהקטגוריה נכונה',
  }),
};

/**
 * חשבונית ללא תאריך — ייתכן קבלה בלבד
 */
const MissingDate: EdgeCaseHandler = {
  name: 'MISSING_DATE',
  description: 'חסר תאריך — ייתכן קבלה בלבד',
  detect: (data) => data.invoice_date == null,
  handle: (_data) => ({
    warning: 'לא נמצא תאריך בחשבונית — ייתכן שמדובר בקבלה בלבד',
  }),
};

// ─── Registry ─────────────────────────────────────────────────────────────────

const HANDLERS: EdgeCaseHandler[] = [
  VatAutoCorrect,   // חשוב שיהיה ראשון — מתקן את הנתונים לפני שאר הבדיקות
  ExemptSupplier,
  CreditNote,
  MissingDate,
];

export function runEdgeCaseHandlers(data: ExtractedData): EdgeCaseResult {
  let current = { ...data };
  const warnings: string[] = [];
  let corrected = false;

  for (const handler of HANDLERS) {
    if (handler.detect(current)) {
      const { warning, ...patch } = handler.handle(current);
      current = { ...current, ...patch };
      if (warning) warnings.push(warning);
      if (Object.keys(patch).length > 0) corrected = true;
    }
  }

  return { data: current, warnings, corrected };
}
