import Anthropic from '@anthropic-ai/sdk';
import { isTransientError } from '@/shared/processing';
import {
  buildSplitSuggestion,
  describeHints,
  parseLlmSplitResult,
  precheckSplit,
  truncatePageText,
  type SplitSuggestion,
} from '@/shared/documentSplit';

const apiKey = process.env.ANTHROPIC_API_KEY;

// Same model as extraction: boundary mistakes cost a reviewer more than the extra tokens.
const MODEL = 'claude-sonnet-4-5-20250929';
// Above this the prompt gets too large to be reliable; such files are left for a manual split.
const MAX_PAGES_FOR_LLM = 60;
// Total OCR characters sent to the LLM, spread evenly over the pages.
const TOTAL_CHAR_BUDGET = 60_000;
const MAX_CHARS_PER_PAGE = 2_500;

// Output budget: each document costs ~60-80 tokens (pages, confidence, a short Hebrew reason),
// so 1024 tokens covered only ~12 documents and a 20-invoice batch came back truncated.
const TOKENS_PER_DOCUMENT = 120;
const BASE_OUTPUT_TOKENS = 1024;
const MAX_OUTPUT_TOKENS = 16_000;

/** Output budget for a file of `pageCount` pages (worst case: one document per page). */
export function splitterMaxTokens(pageCount: number): number {
  return Math.min(MAX_OUTPUT_TOKENS, Math.max(2048, BASE_OUTPUT_TOKENS + pageCount * TOKENS_PER_DOCUMENT));
}

/** The subset of the Anthropic client the splitter uses (injectable for tests). */
export interface SplitterLlm {
  messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming, options?: { timeout?: number; maxRetries?: number }): Promise<Anthropic.Message>;
  };
}

let client: Anthropic | null = null;
function getAnthropicClient(): SplitterLlm | null {
  if (!apiKey) return null;
  if (!client) client = new Anthropic({ apiKey });
  return client;
}

const TOOL_NAME = 'report_document_boundaries';

const TOOL_DEFINITION: Anthropic.Tool = {
  name: TOOL_NAME,
  description: 'דווח כיצד עמודי קובץ ה-PDF מתחלקים למסמכים (חשבוניות) נפרדים',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      documents: {
        type: 'array',
        minItems: 1,
        description: 'רשימת המסמכים לפי סדר העמודים. הטווחים רציפים, מתחילים בעמוד 1, מכסים את כל העמודים וללא חפיפה.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            start_page: { type: 'integer', minimum: 1, description: 'עמוד ראשון של המסמך (מתחיל מ-1)' },
            end_page: { type: 'integer', minimum: 1, description: 'עמוד אחרון של המסמך (כולל)' },
            confidence: { type: 'number', minimum: 0, maximum: 1, description: 'ביטחון שהטווח הזה הוא מסמך שלם ונפרד' },
            reason: { type: 'string', description: 'הסבר קצר מאוד (עד 6 מילים): ספק / מספר חשבונית' },
          },
          required: ['start_page', 'end_page', 'confidence', 'reason'],
        },
      },
      confidence: {
        type: 'number',
        minimum: 0,
        maximum: 1,
        description: 'ביטחון כללי בחלוקה כולה',
      },
    },
    required: ['documents', 'confidence'],
  },
};

const SYSTEM_PROMPT = `אתה מנתח קבצי PDF שנסרקו במשרד הנהלת חשבונות ישראלי. קובץ אחד עשוי להכיל כמה מסמכים נפרדים (חשבוניות מס, חשבוניות מס/קבלה, קבלות, תעודות משלוח) שנסרקו יחד.
מצורף טקסט ה-OCR של כל עמוד, וסיכום של סימנים שזוהו אוטומטית בכל עמוד.
קבע אילו עמודים שייכים לאותו מסמך.

סימנים לתחילת מסמך חדש:
- שם ספק או מספר עוסק מורשה / ח.פ. שונה מהעמוד הקודם.
- מספר חשבונית או תאריך מסמך שונים.
- "עמוד 1 מתוך N" או עמוד שנראה כעמוד ראשון (כותרת "חשבונית מס", לוגו, פרטי ספק ולקוח).

סימנים להמשך אותו מסמך:
- "עמוד 2 מתוך 3" וכדומה, המשך טבלת פריטים, "המשך", סיכום סה"כ שמופיע רק בעמוד האחרון.
- עמוד ריק או עמוד תנאים כלליים / נספח של אותו ספק שייכים למסמך שלפניהם.

אם יש ספק — העדף להשאיר עמודים יחד והורד את רמת הביטחון. אל תפצל עמודים של אותה חשבונית.
החזר תמיד את התשובה דרך ה-tool "${TOOL_NAME}" בלבד. הטווחים חייבים להיות רציפים, להתחיל בעמוד 1, לכסות את כל העמודים ללא חפיפה.`;

export interface BoundaryDetectionResult {
  /** Set only when more than one document was detected. */
  suggestion: SplitSuggestion | null;
  inputTokens: number;
  outputTokens: number;
  /**
   * True when detection was needed but could not give an answer (LLM error, truncated or invalid
   * ranges, too many pages). The pipeline then warns the reviewer and blocks auto-approve, instead
   * of silently treating a possibly multi-invoice file as one invoice.
   */
  failed?: boolean;
}

/**
 * Detects document boundaries in a multi-page PDF from its per-page OCR text.
 * Runs the cheap heuristic pre-check first and only calls the LLM when it can't decide.
 * Never throws without `timeoutMs`: a failed detection means no suggestion, with `failed` set so the
 * reviewer is warned. With `timeoutMs` (the processing queue) transient failures - timeouts, dropped
 * connections, 429 / 5xx - are thrown, so the queue retries detection with backoff instead of
 * silently losing the split suggestion of a long document (QA round 3 review).
 */
export async function detectDocumentBoundaries(
  pageTexts: string[],
  llm: SplitterLlm | null = getAnthropicClient(),
  /** Time limit of each model call (the processing queue's step deadline); no SDK retries then. */
  timeoutMs?: number
): Promise<BoundaryDetectionResult> {
  const none: BoundaryDetectionResult = { suggestion: null, inputTokens: 0, outputTokens: 0 };
  const failed: BoundaryDetectionResult = { ...none, failed: true };
  const pageCount = pageTexts.length;

  const precheck = precheckSplit(pageTexts);
  if (precheck.kind === 'single') {
    console.log(`[Splitter] No split needed (${precheck.reason}).`);
    return none;
  }
  if (precheck.kind === 'resolved') {
    console.log(`[Splitter] ✂️ Boundaries resolved without LLM (${precheck.reason}).`);
    return {
      ...none,
      suggestion: buildSplitSuggestion(precheck.ranges, precheck.confidence, 'page_markers', pageCount),
    };
  }

  if (pageCount > MAX_PAGES_FOR_LLM) {
    console.warn(`[Splitter] ${pageCount} pages exceeds the LLM limit (${MAX_PAGES_FOR_LLM}); leaving split to the reviewer.`);
    return failed;
  }

  const anthropic = llm;
  if (!anthropic) {
    console.warn('[Splitter] Missing ANTHROPIC_API_KEY, skipping boundary detection.');
    return failed;
  }

  const perPage = Math.min(MAX_CHARS_PER_PAGE, Math.floor(TOTAL_CHAR_BUDGET / pageCount));
  const formattedPages = pageTexts
    .map((text, idx) => {
      const body = truncatePageText(text, perPage) || 'עמוד ריק או ללא טקסט קריא';
      return `[עמוד ${idx + 1}]\n"""\n${body}\n"""`;
    })
    .join('\n\n');

  const userText = `הקובץ מכיל ${pageCount} עמודים.

סימנים שזוהו אוטומטית:
${describeHints(precheck.hints)}

טקסט ה-OCR לפי עמודים:

${formattedPages}`;

  // With a time limit, both calls together stay within it (the retry gets what the first one left)
  const startedAt = Date.now();
  const requestOptions = () => (timeoutMs ? { timeout: Math.max(1_000, Math.floor(timeoutMs - (Date.now() - startedAt))), maxRetries: 0 } : undefined);
  const callModel = (maxTokens: number) =>
    anthropic.messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      temperature: 0,
      system: SYSTEM_PROMPT,
      tools: [TOOL_DEFINITION],
      tool_choice: { type: 'tool', name: TOOL_NAME },
      messages: [{ role: 'user', content: userText }],
    }, requestOptions());

  try {
    const firstBudget = splitterMaxTokens(pageCount);
    let response = await callModel(firstBudget);
    const usage = {
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
    };
    // A tool call cut at max_tokens has incomplete `documents` (pages not covered) - retry once
    // with the largest budget before giving up.
    const timeLeft = timeoutMs ? timeoutMs - (Date.now() - startedAt) : Infinity;
    if (response.stop_reason === 'max_tokens' && firstBudget < MAX_OUTPUT_TOKENS && timeLeft >= 5_000) {
      console.warn(`[Splitter] Boundary response hit max_tokens (${firstBudget}) - retrying with ${MAX_OUTPUT_TOKENS}`);
      response = await callModel(MAX_OUTPUT_TOKENS);
      usage.inputTokens += response.usage?.input_tokens ?? 0;
      usage.outputTokens += response.usage?.output_tokens ?? 0;
    }
    if (response.stop_reason === 'max_tokens') {
      console.error('[Splitter] Boundary response still truncated at max_tokens; leaving the split to the reviewer.');
      return { ...failed, ...usage };
    }

    const toolUse = response.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === TOOL_NAME
    );
    if (!toolUse) {
      console.error('[Splitter] Model did not call the boundary tool; no suggestion stored.');
      return { ...failed, ...usage };
    }

    const parsed = parseLlmSplitResult(toolUse.input, pageCount);
    if (!parsed.ok) {
      console.error(`[Splitter] Rejected invalid page ranges from model: ${parsed.error}`, JSON.stringify(toolUse.input));
      return { ...failed, ...usage };
    }

    const { suggestion } = parsed;
    if (suggestion.documents.length <= 1) {
      console.log(`[Splitter] Model sees a single ${pageCount}-page document (confidence ${suggestion.confidence}).`);
      return { suggestion: null, ...usage };
    }

    console.log(
      `[Splitter] ✂️ Model detected ${suggestion.documents.length} documents (confidence ${suggestion.confidence}):`,
      JSON.stringify(suggestion.documents.map((d) => [d.start_page, d.end_page]))
    );
    return { suggestion, ...usage };
  } catch (err) {
    if (timeoutMs && isTransientError(err)) throw err;
    console.error('[Splitter] Boundary detection request failed, continuing without a suggestion:', err);
    return failed;
  }
}
