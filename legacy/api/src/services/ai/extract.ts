import Anthropic from '@anthropic-ai/sdk';
import type { ExtractedData } from '@invoice/shared-types';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const TOOL_DEFINITION: Anthropic.Tool = {
  name: 'save_invoice_data',
  description: 'שמור את הנתונים שחולצו מהחשבונית',
  input_schema: {
    type: 'object',
    properties: {
      supplier_name:     { type: 'string', description: 'שם הספק / ספק השירות' },
      supplier_name_bbox: { '$ref': '#/$defs/bbox' },
      supplier_vat_id:   { type: 'string', description: 'מספר עוסק מורשה / ח.פ. (9 ספרות)' },
      supplier_vat_id_bbox: { '$ref': '#/$defs/bbox' },
      invoice_number:    { type: 'string', description: 'מספר חשבונית' },
      invoice_number_bbox: { '$ref': '#/$defs/bbox' },
      invoice_date:      { type: 'string', description: 'תאריך החשבונית בפורמט YYYY-MM-DD' },
      invoice_date_bbox: { '$ref': '#/$defs/bbox' },
      amount_before_vat: { type: 'number', description: 'סכום לפני מע"מ = total - vat' },
      amount_before_vat_bbox: { '$ref': '#/$defs/bbox' },
      vat_amount:        { type: 'number', description: 'סכום המע"מ בשקלים' },
      vat_amount_bbox:   { '$ref': '#/$defs/bbox' },
      total_amount:      { type: 'number', description: 'סה"כ לתשלום בשקלים' },
      total_amount_bbox: { '$ref': '#/$defs/bbox' },
      expense_category: {
        type: 'string',
        description: `קטגוריית ההוצאה — בחר את המתאימה ביותר:
- "ציוד משרדי": נייר, עטים, מדפסות, מחשבים, ריהוט משרדי, חנות נוחות/סופר
- "שכ\"ד": שכר דירה, ליסינג, דמי שכירות
- "תקשורת": טלפון, סלולרי, אינטרנט, שליחויות, דואר
- "שיווק ופרסום": פרסום, גוגל, עיצוב, הדפסה שיווקית
- "נסיעות": דלק, חניה, מוניות, רכבת, נסיעות עסקיות
- "אחזקה": תיקונים, ניקיון, אחזקת ציוד ומבנה
- "שירותים מקצועיים": עו"ד, רו"ח, יועצים, חברות תוכנה
- "חשמל ומים": חשמל, מים, גז, ארנונה
- "אחר": כל מה שלא מתאים`,
      },
      expense_category_bbox: { '$ref': '#/$defs/bbox' },
    },
    $defs: {
      bbox: {
        type: 'object',
        description: 'מיקום בתמונה. x1,y1 = פינה עליונה-שמאלית, x2,y2 = תחתונה-ימנית. ערכים 0-1 יחסית לגודל המלא של התמונה — (0,0) הוא הפיקסל הקיצוני ביותר למעלה-שמאל, כולל שוליים לבנים. אל תחשב מהתוכן הנראה בלבד.',
        properties: {
          x1: { type: 'number' }, y1: { type: 'number' },
          x2: { type: 'number' }, y2: { type: 'number' },
        },
        required: ['x1', 'y1', 'x2', 'y2'],
      },
    },
    required: [],
  },
};

const SYSTEM_PROMPT = `אתה מומחה לניתוח חשבוניות מס ישראליות.
קרא בקפידה את החשבונית המצורפת וחלץ את כל הנתונים הרלוונטיים.
השתמש תמיד ב-tool "save_invoice_data" להחזרת הנתונים — אל תכתוב JSON חופשי.
אם שדה לא קיים בחשבונית, אל תכלול אותו (השאר null מרומז).
שים לב: מספר עוסק מורשה ישראלי הוא 9 ספרות בדיוק.
תאריכים — המר לפורמט YYYY-MM-DD.
סכומים — ספרות בלבד, ללא סימן מטבע.

כללים חשובים לסכומים בחשבוניות ישראליות:
- "amount_before_vat" = סה"כ לתשלום פחות סכום המע"מ (total - vat).
- "אמ"מ" או "אינו חייב מע"מ" = סכום הפטור ממע"מ — זהו NOT ה-amount_before_vat.
- "מע"מ" = vat_amount (המספר שמופיע לידו).
- "סה"כ" / "לתשלום" / "סה"כ לתשלום" = total_amount.
- הנוסחה תמיד: amount_before_vat = total_amount - vat_amount.
- אם המחירים בשורות הפריטים כוללים מע"מ — עדיין חשב לפי הנוסחה הנ"ל.`;

const RETRY_HINT = `שים לב במיוחד לסכומים: ודא ש-(סכום לפני מע"מ + מע"מ = סה"כ לתשלום).
אם יש אי-התאמה, קרא שוב את המסמך בקפידה ונסה שוב.`;

export async function extractInvoiceData(
  fileUrl: string,
  mimeType: string,
  withRetryHint = false
): Promise<ExtractedData> {
  const imageBuffer = await fetch(fileUrl).then((r) => r.arrayBuffer());
  const base64 = Buffer.from(imageBuffer).toString('base64');

  const mediaType = mimeType.startsWith('image/') ? mimeType as 'image/jpeg' | 'image/png' | 'image/webp' : 'image/jpeg';

  const content: Anthropic.MessageParam['content'] = [
    {
      type: 'image',
      source: { type: 'base64', media_type: mediaType, data: base64 },
    },
    {
      type: 'text',
      text: withRetryHint ? RETRY_HINT : 'נתח את החשבונית וחלץ את הנתונים.',
    },
  ];

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    tools: [TOOL_DEFINITION],
    tool_choice: { type: 'any' },
    messages: [{ role: 'user', content }],
  });

  const toolUse = response.content.find((b) => b.type === 'tool_use') as Anthropic.ToolUseBlock | undefined;
  if (!toolUse) throw new Error('המודל לא החזיר נתוני חשבונית');

  const raw = toolUse.input as Record<string, unknown>;

  const bbox = (key: string) => {
    const b = raw[`${key}_bbox`] as { x1: number; y1: number; x2: number; y2: number } | undefined;
    return b && typeof b.x1 === 'number' ? b : undefined;
  };

  return {
    supplier_name:     (raw.supplier_name as string) ?? null,
    supplier_vat_id:   (raw.supplier_vat_id as string) ?? null,
    invoice_number:    (raw.invoice_number as string) ?? null,
    invoice_date:      (raw.invoice_date as string) ?? null,
    amount_before_vat: (raw.amount_before_vat as number) ?? null,
    vat_amount:        (raw.vat_amount as number) ?? null,
    total_amount:      (raw.total_amount as number) ?? null,
    expense_category:  (raw.expense_category as string) ?? null,
    validation_flags: { math_ok: true, vat_id_ok: true, fields_missing: [] },
    bboxes: {
      supplier_name:     bbox('supplier_name'),
      supplier_vat_id:   bbox('supplier_vat_id'),
      invoice_number:    bbox('invoice_number'),
      invoice_date:      bbox('invoice_date'),
      amount_before_vat: bbox('amount_before_vat'),
      vat_amount:        bbox('vat_amount'),
      total_amount:      bbox('total_amount'),
      expense_category:  bbox('expense_category'),
    },
  };
}
