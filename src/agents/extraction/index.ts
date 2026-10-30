import Anthropic from '@anthropic-ai/sdk';
import type { ExtractedData } from '@/shared/types';
import { formatFewShotPrompt, type FewShotExample } from '@/shared/fewshot';
import { MAX_LINE_ITEMS, normalizeLineItems } from '@/shared/lineItems';
import { normalizeFieldConfidence } from '@/shared/confidence';

const apiKey = process.env.ANTHROPIC_API_KEY;

let client: Anthropic | null = null;
function getAnthropicClient() {
  if (!client) {
    if (!apiKey) {
      throw new Error('Missing environment variable: ANTHROPIC_API_KEY');
    }
    client = new Anthropic({ apiKey });
  }
  return client;
}

const TOOL_DEFINITION: Anthropic.Tool = {
  name: 'save_invoice_data',
  description: 'שמור את הנתונים שחולצו מהחשבונית',
  input_schema: {
    type: 'object',
    properties: {
      supplier_name:     { type: 'string', description: 'שם הספק / ספק השירות' },
      supplier_name_bbox: { '$ref': '#/$defs/bbox' },
      supplier_vat_id:   { type: 'string', description: 'מספר עוסק מורשה / ח.פ. (9 ספרות) של הספק המנפיק את החשבונית (המוכר), מכותרת המסמך / פרטי העסק המנפיק. לעולם לא המספר שליד "לכבוד", "לקוח", "ח.פ לקוח" או בפרטי הקונה.' },
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
      allocation_number: { type: 'string', description: 'מספר הקצאה מרשות המסים (חשבוניות ישראל), בדרך כלל 9 ספרות, מופיע ליד "מספר הקצאה" / "מס׳ הקצאה". לא מספר החשבונית ולא ח.פ.' },
      allocation_number_bbox: { '$ref': '#/$defs/bbox' },
      bank_name:         { type: 'string', description: 'שם הבנק להעברה בנקאית (למשל הבינלאומי, לאומי, הפועלים)' },
      bank_branch_code:  { type: 'string', description: 'מספר סניף הבנק (למשל 109)' },
      bank_branch_name:  { type: 'string', description: 'שם סניף הבנק (למשל אשקלון)' },
      bank_account:      { type: 'string', description: 'מספר חשבון הבנק להעברה' },
      line_items: {
        type: 'array',
        maxItems: MAX_LINE_ITEMS,
        description: `שורות הפריטים / השירותים בחשבונית, לפי הסדר (עד ${MAX_LINE_ITEMS} שורות). כלול גם שורות הנחה (סכום שלילי) ודמי משלוח. אל תכלול שורות סיכום (סה"כ, מע"מ, לתשלום).`,
        items: {
          type: 'object',
          properties: {
            description: { type: 'string', description: 'תיאור הפריט / השירות' },
            quantity:    { type: 'number', description: 'כמות' },
            unit_price:  { type: 'number', description: 'מחיר ליחידה' },
            line_total:  { type: 'number', description: 'סה"כ לשורה כפי שמודפס בחשבונית' },
            vat_exempt:  { type: 'boolean', description: 'true רק אם השורה מסומנת במפורש כפטורה ממע"מ / ללא מע"מ' },
          },
          required: ['line_total'],
        },
      },
      field_confidence: {
        type: 'object',
        description: 'רמת הביטחון שלך (0 עד 1) בכל שדה שחילצת: 1 = מודפס בבירור וחד-משמעי, 0.5 = ניחוש מהקשר / טקסט OCR משובש, 0.2 = כמעט ניחוש. כלול רק שדות שחילצת.',
        properties: {
          supplier_name:     { type: 'number', minimum: 0, maximum: 1 },
          supplier_vat_id:   { type: 'number', minimum: 0, maximum: 1 },
          invoice_number:    { type: 'number', minimum: 0, maximum: 1 },
          invoice_date:      { type: 'number', minimum: 0, maximum: 1 },
          amount_before_vat: { type: 'number', minimum: 0, maximum: 1 },
          vat_amount:        { type: 'number', minimum: 0, maximum: 1 },
          total_amount:      { type: 'number', minimum: 0, maximum: 1 },
          expense_category:  { type: 'number', minimum: 0, maximum: 1 },
          allocation_number: { type: 'number', minimum: 0, maximum: 1 },
        },
      },
    },
    $defs: {
      bbox: {
        type: 'object',
        description: 'מיקום בתמונה. x1,y1 = פינה עליונה-שמאלית, x2,y2 = תחתונה-ימנית. ערכים 0-1 יחסית לגודל המלא של התמונה. אל תחשב מהתוכן הנראה בלבד.',
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

// The buyer's ID is printed on every invoice too (customer block); the model must take the issuer's.
const SUPPLIER_VAT_ID_RULE = `ח.פ. הספק (supplier_vat_id) — זהו מספר העוסק המורשה / ח.פ. של העסק שהנפיק את החשבונית (המוכר), שמופיע בכותרת או בתחתית המסמך ליד שם הספק. בחשבונית מופיע לעיתים גם מספר של הלקוח (הקונה) — ליד "לכבוד", "לקוח", "ח.פ לקוח", "עוסק מורשה לקוח", "מספר לקוח" או בבלוק פרטי הלקוח. לעולם אל תחזיר את המספר של הלקוח כ-supplier_vat_id. אם לא ברור איזה מספר שייך לספק — השאר את השדה ריק או תן ביטחון נמוך (0.5 ומטה).
שים לב לטבלאות פרטי לקוח (שם לקוח / ח.פ לקוח / מס' כרטיס לקוח / טלפון לקוח): בטקסט ה-OCR עמודת הכותרות ועמודת הערכים מופיעות לעיתים כרשימות נפרדות, כך שהמספר לא צמוד לתווית שלו — כל מספר מתוך טבלה כזו שייך ללקוח. גם "מספר ספק" / "מס' ספק אצלנו" הוא מספר פנימי של הלקוח ואינו ח.פ. הספק. המסמך עשוי להיות סרוק הפוך או מסובב.
ח.פ. הספק הנכון מופיע בדרך כלל בשורה אחת עם שם העסק המנפיק ("בע״מ") או בשורת הכתובת/טלפון שלו, ליד "ח.פ" / "ע.מ" / "עוסק מורשה". אם בעמוד יותר ממספר אחד בן 9 ספרות — תן ל-supplier_vat_id ביטחון של 0.8 לכל היותר, אלא אם המספר צמוד לתווית ח.פ של המנפיק.`;

// A continuation page ("עמוד 2 מתוך 4") has line items but no totals: amounts must not be invented.
const PRINTED_AMOUNTS_RULE = `סכומים (vat_amount, total_amount) — רק כפי שהם מודפסים בשורות הסיכום של המסמך (amount_before_vat מחושב מהם לפי הנוסחה). אם בעמוד אין שורת סיכום (למשל עמוד המשך "עמוד 2 מתוך 4" עם שורות פריטים בלבד) — אל תסכם את שורות הפריטים ואל תחשב מע"מ לפי שיעור משוער; השאר את הסכומים ריקים.`;

const SYSTEM_PROMPT_TEXT_ONLY = `אתה מומחה לניתוח חשבוניות מס ישראליות מטקסט OCR.
קרא בקפידה את טקסט ה-OCR המצורף וחלץ את כל הנתונים הרלוונטיים.

You will receive raw OCR text from bilingual Israeli invoices. The text may have mixed RTL/LTR layout strings where numbers and labels are inverted. Use proximity and semantic context to reconstruct the correct connections (e.g., matching the word 'סה"כ' with the nearby floating number).

השתמש תמיד ב-tool "save_invoice_data" להחזרת הנתונים — אל תכתוב JSON חופשי.
אם שדה לא קיים, אל תכלול אותו (השאר null מרומז).
שים לב: מספר עוסק מורשה ישראלי (ח.פ. / ע.מ.) הוא 9 ספרות בדיוק.
${SUPPLIER_VAT_ID_RULE}
${PRINTED_AMOUNTS_RULE}
תאריכים — המר לפורמט YYYY-MM-DD.
סכומים — ספרות בלבד, ללא סימן מטבע.
מספר הקצאה — אם מופיע "מספר הקצאה" (רשות המסים), חלץ אותו כ-allocation_number. אל תבלבל עם מספר החשבונית או מספר העוסק.
פרטי חשבון בנק — אם מופיעים פרטי העברה בנקאית (שם בנק, מספר/שם סניף, מספר חשבון), חלץ אותם במדויק.
שורות פריטים — אם יש טבלת פריטים, חלץ כל שורה ל-line_items (תיאור, כמות, מחיר ליחידה, סה"כ שורה; vat_exempt=true לשורה פטורה ממע"מ). עד ${MAX_LINE_ITEMS} שורות.
ביטחון — מלא field_confidence עם ציון 0-1 לכל שדה שחילצת. היה כן: ציון נמוך לשדה שקראת מטקסט משובש או הסקת מהקשר.

כללים חשובים לסכומים בחשבוניות ישראליות:
- "amount_before_vat" = סה"כ לתשלום פחות סכום המע"מ (total - vat).
- "אמ"מ" או "אינו חייב מע"מ" = סכום הפטור ממע"מ — זהו NOT ה-amount_before_vat.
- "מע"מ" = vat_amount (המספר שמופיע לידו).
- "סה"כ" / "לתשלום" / "סה"כ לתשלום" = total_amount.
- הנוסחה תמיד: amount_before_vat = total_amount - vat_amount.
- אם המחירים בשורות הפריטים כוללים מע"מ — עדיין חשב לפי הנוסחה הנ"ל.`;

const SYSTEM_PROMPT_VISION = `אתה מומחה לניתוח חשבוניות מס ישראליות באמצעות תמונה וטקסט OCR משולבים.
קרא בקפידה את התמונה המצורפת ואת טקסט ה-OCR וחלץ את כל הנתונים הרלוונטיים.

You will receive raw OCR text from bilingual Israeli invoices. The text may have mixed RTL/LTR layout strings where numbers and labels are inverted. Use proximity and semantic context to reconstruct the correct connections (e.g., matching the word 'סה"כ' with the nearby floating number).

השתמש תמיד ב-tool "save_invoice_data" להחזרת הנתונים.
אם שדה לא קיים, אל תכלול אותו.
חלץ גם פרטי העברה בנקאית של הספק (בנק, סניף, חשבון) אם רשומים במסמך.
${SUPPLIER_VAT_ID_RULE}
${PRINTED_AMOUNTS_RULE}
חלץ את "מספר הקצאה" של רשות המסים כ-allocation_number אם מופיע (לא מספר החשבונית ולא ח.פ.).
חלץ את שורות הפריטים ל-line_items (עד ${MAX_LINE_ITEMS} שורות, vat_exempt=true לשורה פטורה ממע"מ) ומלא field_confidence (0-1) לכל שדה שחילצת.
הנוסחה תמיד: amount_before_vat = total_amount - vat_amount.`;

const RETRY_HINT = `שים לב במיוחד לסכומים: ודא ש-(סכום לפני מע"מ + מע"מ = סה"כ לתשלום).
אם יש אי-התאמה, קרא שוב את המסמך בקפידה ונסה שוב.`;

export async function extractInvoiceData(
  rawOcrText: string | null,
  fileUrl: string,
  mimeType: string,
  useVisionFallback = false,
  withRetryHint = false,
  fewShot: { examples: FewShotExample[]; supplierVatId: string | null } = { examples: [], supplierVatId: null }
): Promise<{
  extractedData: ExtractedData;
  inputTokens: number;
  outputTokens: number;
  /** Ids of the past invoices that were included as few-shot examples. */
  fewShotInvoiceIds: string[];
}> {
  const anthropic = getAnthropicClient();
  const content: Anthropic.MessageParam['content'] = [];

  // Decide if we should fetch and send the image (fallback / missing OCR text)
  const shouldSendImage = useVisionFallback || !rawOcrText;

  if (shouldSendImage) {
    console.log(`[Extraction] Performing multimodal vision extraction (fallback or missing OCR)`);
    const imageBuffer = await fetch(fileUrl).then((r) => r.arrayBuffer());
    const base64 = Buffer.from(imageBuffer).toString('base64');
    const mediaType = mimeType.startsWith('image/')
      ? (mimeType as 'image/jpeg' | 'image/png' | 'image/webp')
      : 'image/jpeg';

    content.push({
      type: 'image',
      source: { type: 'base64', media_type: mediaType, data: base64 },
    });
  } else {
    console.log(`[Extraction] Performing text-only extraction using raw OCR text`);
  }

  // Per-supplier examples from human-reviewed invoices go before the invoice itself
  const { text: fewShotText, usedInvoiceIds } = formatFewShotPrompt(fewShot.examples, fewShot.supplierVatId);
  if (fewShotText) {
    content.push({ type: 'text', text: fewShotText });
  }

  // Construct text prompts
  let promptText = fewShotText
    ? `החשבונית הנוכחית — נתח אותה וחלץ את הנתונים.`
    : `נתח את החשבונית וחלץ את הנתונים.`;
  if (rawOcrText) {
    promptText += `\n\nטקסט ה-OCR של החשבונית:\n\"\"\"\n${rawOcrText}\n\"\"\"`;
  }
  if (withRetryHint) {
    promptText += `\n\n${RETRY_HINT}`;
  }

  content.push({
    type: 'text',
    text: promptText,
  });

  const callModel = (maxTokens: number) =>
    anthropic.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: maxTokens,
      system: shouldSendImage ? SYSTEM_PROMPT_VISION : SYSTEM_PROMPT_TEXT_ONLY,
      tools: [TOOL_DEFINITION],
      tool_choice: { type: 'any' },
      messages: [{ role: 'user', content }],
    });

  // 1024 was enough for the scalar fields; up to MAX_LINE_ITEMS lines + confidences need more.
  // A tool call cut at max_tokens may lose every field (not just line_items), so retry once
  // with a larger budget (billing is per token actually generated).
  let response = await callModel(4096);
  let inputTokens = response.usage?.input_tokens ?? 0;
  let outputTokens = response.usage?.output_tokens ?? 0;
  if (response.stop_reason === 'max_tokens') {
    console.warn('[Extraction] Response hit max_tokens (4096) — retrying with 16384');
    response = await callModel(16384);
    inputTokens += response.usage?.input_tokens ?? 0;
    outputTokens += response.usage?.output_tokens ?? 0;
    if (response.stop_reason === 'max_tokens') {
      console.warn('[Extraction] Response hit max_tokens again — tool input may be truncated');
    }
  }

  const toolUse = response.content.find((b) => b.type === 'tool_use') as Anthropic.ToolUseBlock | undefined;
  if (!toolUse) throw new Error('המודל לא החזיר נתוני חשבונית');

  const raw = toolUse.input as Record<string, unknown>;

  const bbox = (key: string) => {
    const b = raw[`${key}_bbox`] as { x1: number; y1: number; x2: number; y2: number } | undefined;
    return b && typeof b.x1 === 'number' ? b : undefined;
  };

  const lineItems = normalizeLineItems(raw.line_items);

  const extractedData: ExtractedData = {
    supplier_name:     (raw.supplier_name as string) ?? null,
    supplier_vat_id:   (raw.supplier_vat_id as string) ?? null,
    invoice_number:    (raw.invoice_number as string) ?? null,
    invoice_date:      (raw.invoice_date as string) ?? null,
    amount_before_vat: (raw.amount_before_vat as number) ?? null,
    vat_amount:        (raw.vat_amount as number) ?? null,
    total_amount:      (raw.total_amount as number) ?? null,
    expense_category:  (raw.expense_category as string) ?? null,
    allocation_number: (raw.allocation_number as string) ?? null,
    bank_name:         (raw.bank_name as string) ?? null,
    bank_branch_code:  (raw.bank_branch_code as string) ?? null,
    bank_branch_name:  (raw.bank_branch_name as string) ?? null,
    bank_account:      (raw.bank_account as string) ?? null,
    line_items:        lineItems.length > 0 ? lineItems : null,
    field_confidence:  normalizeFieldConfidence(raw.field_confidence),
    bboxes: {
      supplier_name:     bbox('supplier_name'),
      supplier_vat_id:   bbox('supplier_vat_id'),
      invoice_number:    bbox('invoice_number'),
      invoice_date:      bbox('invoice_date'),
      amount_before_vat: bbox('amount_before_vat'),
      vat_amount:        bbox('vat_amount'),
      total_amount:      bbox('total_amount'),
      expense_category:  bbox('expense_category'),
      allocation_number: bbox('allocation_number'),
    },
  };

  return {
    extractedData,
    inputTokens,
    outputTokens,
    fewShotInvoiceIds: usedInvoiceIds,
  };
}
