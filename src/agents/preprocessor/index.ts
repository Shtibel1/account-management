import type { OcrMetadata, OcrWord } from '@/shared/types';
import { PDFDocument } from 'pdf-lib';

function extractWordsFromPage(pageRes: any, pageIndex: number): OcrWord[] {
  const words: OcrWord[] = [];
  const fullTextAnnotation = pageRes.fullTextAnnotation;
  if (!fullTextAnnotation?.pages) return words;

  for (const page of fullTextAnnotation.pages) {
    const pageWidth = page.width || 1;
    const pageHeight = page.height || 1;

    if (!page.blocks) continue;
    for (const block of page.blocks) {
      if (!block.paragraphs) continue;
      for (const paragraph of block.paragraphs) {
        if (!paragraph.words) continue;
        for (const word of paragraph.words) {
          const text = word.symbols?.map((s: any) => s.text).join('') || '';
          if (!text) continue;

          const vertices = word.boundingBox?.normalizedVertices || word.boundingBox?.vertices;
          if (vertices && vertices.length >= 4) {
            const isNormalized = word.boundingBox?.normalizedVertices !== undefined;
            const xs = vertices.map((v: any) => v.x ?? 0);
            const ys = vertices.map((v: any) => v.y ?? 0);

            const x1 = Math.min(...xs) / (isNormalized ? 1 : pageWidth);
            const y1 = Math.min(...ys) / (isNormalized ? 1 : pageHeight);
            const x2 = Math.max(...xs) / (isNormalized ? 1 : pageWidth);
            const y2 = Math.max(...ys) / (isNormalized ? 1 : pageHeight);

            words.push({
              text,
              bbox: { x1, y1, x2, y2 },
              page: pageIndex,
            });
          }
        }
      }
    }
  }
  return words;
}

/** Options of one Vision call made by the processing queue. */
export interface OcrCallOptions {
  /** Time limit of the call (ms): it must end before its request's deadline (nothing runs after a response on Amplify). */
  timeoutMs?: number;
}

/** POST to Vision; a failed status throws with `status` set (429 / 5xx are retried by the queue). */
async function postVision(apiUrl: string, payload: unknown, label: string, options: OcrCallOptions): Promise<Response> {
  const apiResponse = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    ...(options.timeoutMs ? { signal: AbortSignal.timeout(Math.max(1_000, Math.floor(options.timeoutMs))) } : {}),
  });
  if (!apiResponse.ok) {
    // Raw vendor detail goes to the server log; callers map the error to Hebrew (toUserErrorMessage)
    const errText = await apiResponse.text();
    throw Object.assign(new Error(`Google Cloud Vision ${label} request failed: ${apiResponse.statusText}. Details: ${errText}`), {
      status: apiResponse.status,
    });
  }
  return apiResponse;
}

async function runOcrForPageRange(
  base64Data: string,
  apiKey: string,
  pages: number[],
  /** Page numbers to report for each requested page (defaults to `pages`). */
  reportAs: number[] = pages,
  options: OcrCallOptions = {}
): Promise<{ pageTexts: string[]; ocrWords: OcrWord[] }> {
  const apiUrl = `https://vision.googleapis.com/v1/files:annotate?key=${apiKey}`;
  const payload = {
    requests: [
      {
        inputConfig: {
          content: base64Data,
          mimeType: 'application/pdf',
        },
        features: [
          {
            type: 'DOCUMENT_TEXT_DETECTION',
          },
        ],
        pages: pages,
      },
    ],
  };

  const apiResponse = await postVision(apiUrl, payload, 'page range OCR', options);
  const data = await apiResponse.json();
  const fileResponses = data.responses?.[0]?.responses;
  if (!fileResponses || !Array.isArray(fileResponses)) {
    throw new Error('Google Cloud Vision returned empty PDF OCR responses for page range');
  }

  const pageTexts: string[] = [];
  let ocrWords: OcrWord[] = [];

  fileResponses.forEach((pageRes, idx) => {
    if (pageRes.error) {
      throw new Error(`Google Cloud Vision page OCR error: ${pageRes.error.message}`);
    }
    pageTexts.push(pageRes.fullTextAnnotation?.text || '');
    const pageWords = extractWordsFromPage(pageRes, reportAs[idx] || pages[idx] || 1);
    ocrWords = ocrWords.concat(pageWords);
  });

  return { pageTexts, ocrWords };
}

/** Downloads the stored invoice file. */
export async function fetchInvoiceFile(fileUrl: string): Promise<Buffer> {
  try {
    const response = await fetch(fileUrl);
    if (!response.ok) {
      throw new Error(`Failed to download invoice file. HTTP status: ${response.status}`);
    }
    return Buffer.from(await response.arrayBuffer());
  } catch (e) {
    console.error(`[Preprocessor] Error downloading invoice file from URL: ${fileUrl.split('?')[0]}`, e);
    throw new Error(`Preprocessor failed to retrieve invoice file: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function visionApiKey(): string {
  const apiKey = process.env.GOOGLE_CLOUD_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error('Google Cloud Vision API key is not configured. Please set GOOGLE_CLOUD_API_KEY.');
  }
  return apiKey;
}

/** Loads a PDF for page-batched OCR; null when pdf-lib can't read it (Vision may still). */
export async function loadPdf(fileBuffer: Buffer): Promise<PDFDocument | null> {
  try {
    return await PDFDocument.load(fileBuffer, { ignoreEncryption: true });
  } catch (e) {
    console.warn('[Preprocessor] Failed to read PDF pages with pdf-lib:', e);
    return null;
  }
}

/**
 * OCRs the given 1-based pages of a PDF. Only those pages are sent: they are copied into a small
 * PDF first, so a 10 MB / 25-page scan doesn't upload the whole file with every 5-page request.
 * Without a parsed document (pdf-lib failed) the whole file is sent, as before.
 */
export async function ocrPdfPages(
  fileBuffer: Buffer,
  pdfDoc: PDFDocument | null,
  pages: number[],
  options: OcrCallOptions = {}
): Promise<{ pageTexts: string[]; ocrWords: OcrWord[] }> {
  const apiKey = visionApiKey();
  if (!pdfDoc) {
    return runOcrForPageRange(fileBuffer.toString('base64'), apiKey, pages, pages, options);
  }
  const subDoc = await PDFDocument.create();
  const copied = await subDoc.copyPages(pdfDoc, pages.map((p) => p - 1));
  copied.forEach((page) => subDoc.addPage(page));
  const subBytes = Buffer.from(await subDoc.save());
  return runOcrForPageRange(subBytes.toString('base64'), apiKey, pages.map((_, i) => i + 1), pages, options);
}

/** OCR of a single image (JPEG / PNG / WEBP...). */
export async function ocrImage(fileBuffer: Buffer, options: OcrCallOptions = {}): Promise<{
  rawOcrText: string;
  ocrWords: OcrWord[];
  pageCount: number;
  confidence: number;
  detectedLanguages: string[];
}> {
  const apiKey = visionApiKey();
  const apiUrl = `https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`;
  const payload = {
    requests: [
      {
        image: { content: fileBuffer.toString('base64') },
        features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
        imageContext: { languageHints: ['he', 'en'] },
      },
    ],
  };

  const apiResponse = await postVision(apiUrl, payload, 'Image OCR', options);
  const data = await apiResponse.json();
  const imageResponse = data.responses?.[0];
  let rawOcrText = '';
  let ocrWords: OcrWord[] = [];
  let pageCount = 1;
  let confidence = 0.95;
  const detectedLanguages = new Set<string>();

  if (imageResponse) {
    if (imageResponse.error) {
      throw new Error(`Google Cloud Vision image OCR error: ${imageResponse.error.message}`);
    }
    const annotation = imageResponse.fullTextAnnotation;
    if (annotation) {
      rawOcrText = annotation.text || '';
      ocrWords = extractWordsFromPage(imageResponse, 1);
      if (annotation.pages) {
        pageCount = annotation.pages.length;
        let totalConfidence = 0;
        let confidenceCount = 0;
        for (const page of annotation.pages) {
          if (page.confidence !== undefined) {
            totalConfidence += page.confidence;
            confidenceCount++;
          }
          for (const lang of page.property?.detectedLanguages ?? []) {
            if (lang.languageCode) detectedLanguages.add(lang.languageCode);
          }
        }
        if (confidenceCount > 0) confidence = totalConfidence / confidenceCount;
      }
    }
  }

  return { rawOcrText, ocrWords, pageCount, confidence, detectedLanguages: normalizeLanguages(Array.from(detectedLanguages)) };
}

export function normalizeLanguages(languages: string[]): string[] {
  const normalized = languages.map((lang) => (lang === 'iw' ? 'he' : lang));
  return normalized.length > 0 ? normalized : ['he'];
}

/**
 * Whole-file OCR in one call (kept for callers outside the queue). The processing queue
 * (src/lib/processingQueue.ts) uses ocrPdfPages / ocrImage directly, a few pages per tick.
 */
export async function preprocessInvoice(
  fileUrl: string,
  mimeType: string
): Promise<{
  rawOcrText: string;
  ocrMetadata: OcrMetadata;
  ocrOpCount: number;
  pageTexts?: string[];
  ocrWords?: OcrWord[];
}> {
  console.log(`[Preprocessor] 📄 Starting OCR preprocessing for file URL: ${fileUrl.split('?')[0]} (${mimeType})`);
  visionApiKey();
  const fileBuffer = await fetchInvoiceFile(fileUrl);
  const isPdf = mimeType === 'application/pdf' || fileUrl.toLowerCase().split('?')[0].endsWith('.pdf');

  if (!isPdf) {
    const img = await ocrImage(fileBuffer);
    return {
      rawOcrText: img.rawOcrText,
      ocrMetadata: { pageCount: img.pageCount, detectedLanguages: img.detectedLanguages, confidence: img.confidence },
      ocrOpCount: Math.ceil(img.pageCount / 5),
      pageTexts: [img.rawOcrText],
      ocrWords: img.ocrWords,
    };
  }

  const pdfDoc = await loadPdf(fileBuffer);
  const pageCount = pdfDoc?.getPageCount() ?? 0;
  if (!pdfDoc || pageCount === 0) {
    // pdf-lib couldn't read it: let Vision try the first page
    const res = await ocrPdfPages(fileBuffer, null, [1]);
    const text = res.pageTexts[0] || '';
    return {
      rawOcrText: text,
      ocrMetadata: { pageCount: 1, detectedLanguages: ['he'], confidence: 0.95 },
      ocrOpCount: 1,
      pageTexts: [text],
      ocrWords: res.ocrWords,
    };
  }

  const batches: number[][] = [];
  for (let i = 1; i <= pageCount; i += 5) {
    const batch: number[] = [];
    for (let p = i; p < i + 5 && p <= pageCount; p++) batch.push(p);
    batches.push(batch);
  }
  const results = await Promise.all(batches.map((pages) => ocrPdfPages(fileBuffer, pdfDoc, pages)));
  const pageTexts = results.flatMap((r) => r.pageTexts);
  return {
    rawOcrText: pageTexts.join('\n\n'),
    ocrMetadata: { pageCount, detectedLanguages: ['he'], confidence: 0.95 },
    ocrOpCount: Math.ceil(pageCount / 5),
    pageTexts,
    ocrWords: results.flatMap((r) => r.ocrWords),
  };
}
