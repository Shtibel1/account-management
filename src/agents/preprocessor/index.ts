import type { OcrMetadata, OcrWord } from '@/shared/types';
import { PDFDocument } from 'pdf-lib';
import Anthropic from '@anthropic-ai/sdk';

const anthropicApiKey = process.env.ANTHROPIC_API_KEY;

async function detectInvoiceSplits(
  pageTexts: string[]
): Promise<{ start_page: number; end_page: number }[]> {
  if (!anthropicApiKey) {
    console.warn('[Preprocessor] Missing ANTHROPIC_API_KEY, skipping smart split.');
    return [{ start_page: 1, end_page: pageTexts.length }];
  }

  const anthropic = new Anthropic({ apiKey: anthropicApiKey });
  const formattedPages = pageTexts
    .map((text, idx) => `[עמוד ${idx + 1}]:\n\"\"\"\n${text || 'עמוד ריק או ללא טקסט קריא'}\n\"\"\"`)
    .join('\n\n');

  const systemPrompt = `אתה עוזר פיננסי חכם שקובע כיצד לפצל קובץ PDF יחיד המכיל מספר חשבוניות מס ישראליות שונות.
מצורף טקסט ה-OCR של כל עמוד במסמך.
עליך לנתח את העמודים ולקבוע אילו עמודים שייכים לאותה חשבונית (רב-עמודית) ואילו עמודים מתחילים חשבונית חדשה.

כללים לזיהוי חשבונית חדשה:
1. שינוי שם הספק או מספר עוסק מורשה (ח.פ.).
2. שינוי תאריך החשבונית או מספר החשבונית.
3. עמוד שנראה בבירור כדף ראשון של מסמך (כותרת גדולה, לוגו, פרטי ספק).

החזר את התשובה בפורמט JSON בלבד, במבנה הבא:
{
  "splits": [
    { "start_page": 1, "end_page": 2 },
    { "start_page": 3, "end_page": 3 }
  ]
}
אל תוסיף שום הסבר או טקסט נוסף לפני או אחרי ה-JSON.`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-3-haiku-20240307',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: `אנא קבע את גבולות החשבוניות עבור עמודי המסמך הבאים:\n\n${formattedPages}`,
        },
      ],
    });

    const text = response.content.find((b) => b.type === 'text')?.text || '';
    const cleanText = text.replace(/```json/g, '').replace(/```/g, '').trim();
    const result = JSON.parse(cleanText);
    if (result && Array.isArray(result.splits)) {
      console.log(`[Preprocessor] 🤖 AI split detection succeeded. Identified ${result.splits.length} parts:`, JSON.stringify(result.splits));
      return result.splits;
    }
  } catch (err) {
    console.error('[Preprocessor] Failed to parse splits JSON from AI response:', err);
  }

  // Fallback
  return [{ start_page: 1, end_page: pageTexts.length }];
}

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

async function runOcrForPageRange(
  base64Data: string,
  apiKey: string,
  pages: number[]
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

  const apiResponse = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!apiResponse.ok) {
    const errText = await apiResponse.text();
    throw new Error(`Google Cloud Vision page range OCR request failed: ${apiResponse.statusText}. Details: ${errText}`);
  }

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
    const pageWords = extractWordsFromPage(pageRes, pages[idx] || 1);
    ocrWords = ocrWords.concat(pageWords);
  });

  return { pageTexts, ocrWords };
}

export async function preprocessInvoice(
  fileUrl: string,
  mimeType: string
): Promise<{
  rawOcrText: string;
  ocrMetadata: OcrMetadata;
  ocrOpCount: number;
  splits?: { start_page: number; end_page: number }[];
  pageTexts?: string[];
  ocrWords?: OcrWord[];
}> {
  console.log(`[Preprocessor] 📄 Starting OCR preprocessing for file URL: ${fileUrl} (${mimeType})`);

  const apiKey = process.env.GOOGLE_CLOUD_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error('Google Cloud Vision API key is not configured. Please set GOOGLE_CLOUD_API_KEY.');
  }

  // 1. Fetch file content
  let fileBuffer: Buffer;
  try {
    const response = await fetch(fileUrl);
    if (!response.ok) {
      throw new Error(`Failed to download invoice file. HTTP status: ${response.status}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    fileBuffer = Buffer.from(arrayBuffer);
  } catch (e) {
    console.error(`[Preprocessor] Error downloading invoice file from URL: ${fileUrl}`, e);
    throw new Error(`Preprocessor failed to retrieve invoice file: ${e instanceof Error ? e.message : String(e)}`);
  }

  const base64Data = fileBuffer.toString('base64');
  const isPdf = mimeType === 'application/pdf' || fileUrl.toLowerCase().split('?')[0].endsWith('.pdf');

  let rawOcrText = '';
  let pageCount = 1;
  let confidence = 0.95;
  const detectedLanguages = new Set<string>();
  let splits: { start_page: number; end_page: number }[] = [];
  let pageTexts: string[] = [];
  let ocrWords: OcrWord[] = [];

  if (isPdf) {
    console.log(`[Preprocessor] Processing as PDF via files:annotate`);
    
    // Read PDF structure with pdf-lib to get actual page count
    let pdfPageCount = 0;
    try {
      const pdfDoc = await PDFDocument.load(fileBuffer);
      pdfPageCount = pdfDoc.getPageCount();
    } catch (e) {
      console.warn('[Preprocessor] Failed to read PDF pages with pdf-lib, falling back to Vision page count detection:', e);
    }

    if (pdfPageCount === 0) {
      // Fallback: request first page only to get page count if pdf-lib failed
      const ocrRes = await runOcrForPageRange(base64Data, apiKey, [1]);
      rawOcrText = ocrRes.pageTexts[0] || '';
      ocrWords = ocrRes.ocrWords;
      pageCount = 1;
      splits = [{ start_page: 1, end_page: 1 }];
      pageTexts = [rawOcrText];
    } else {
      pageCount = pdfPageCount;
      console.log(`[Preprocessor] 📊 PDF has ${pdfPageCount} pages. Running page-by-page OCR in batches...`);

      // Run OCR in batches of 5 pages in parallel
      const batchPromises: Promise<{ pageTexts: string[]; ocrWords: OcrWord[] }>[] = [];
      const batchSize = 5;
      for (let i = 0; i < pdfPageCount; i += batchSize) {
        const pagesToRequest = [];
        for (let j = i; j < Math.min(i + batchSize, pdfPageCount); j++) {
          pagesToRequest.push(j + 1);
        }
        console.log(`[Preprocessor]   Scheduling OCR batch for pages: ${pagesToRequest.join('-')}`);
        batchPromises.push(runOcrForPageRange(base64Data, apiKey, pagesToRequest));
      }

      const batchResults = await Promise.all(batchPromises);
      const allPageTexts = batchResults.flatMap((r) => r.pageTexts);
      ocrWords = batchResults.flatMap((r) => r.ocrWords);

      rawOcrText = allPageTexts.join('\n\n');
      pageTexts = allPageTexts;

      // Run AI split detection if PDF is multi-page
      if (pdfPageCount > 1) {
        splits = await detectInvoiceSplits(allPageTexts);
      } else {
        splits = [{ start_page: 1, end_page: 1 }];
      }
    }
  } else {
    // Processing as Image
    console.log(`[Preprocessor] Processing as Image via images:annotate`);
    const apiUrl = `https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`;
    const payload = {
      requests: [
        {
          image: {
            content: base64Data,
          },
          features: [
            {
              type: 'DOCUMENT_TEXT_DETECTION',
            },
          ],
          imageContext: {
            languageHints: ['he', 'en'],
          },
        },
      ],
    };

    const apiResponse = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!apiResponse.ok) {
      const errText = await apiResponse.text();
      throw new Error(`Google Cloud Vision Image OCR request failed: ${apiResponse.statusText}. Details: ${errText}`);
    }

    const data = await apiResponse.json();
    const imageResponse = data.responses?.[0];

    if (imageResponse) {
      if (imageResponse.error) {
        throw new Error(`Google Cloud Vision image OCR error: ${imageResponse.error.message}`);
      }
      const annotation = imageResponse.fullTextAnnotation;
      if (annotation) {
        rawOcrText = annotation.text || '';
        
        // Extract words from image fullTextAnnotation
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
            if (page.property?.detectedLanguages) {
              for (const lang of page.property.detectedLanguages) {
                if (lang.languageCode) {
                  detectedLanguages.add(lang.languageCode);
                }
              }
            }
          }
          if (confidenceCount > 0) {
            confidence = totalConfidence / confidenceCount;
          }
        }
      }
    }
    splits = [{ start_page: 1, end_page: 1 }];
    pageTexts = [rawOcrText];
  }

  const normalizedLanguages = Array.from(detectedLanguages).map((lang) => 
    lang === 'iw' ? 'he' : lang
  );

  if (normalizedLanguages.length === 0) {
    normalizedLanguages.push('he');
  }

  return {
    rawOcrText,
    ocrMetadata: {
      pageCount,
      detectedLanguages: normalizedLanguages,
      confidence,
    },
    ocrOpCount: Math.ceil(pageCount / 5),
    splits,
    pageTexts,
    ocrWords,
  };
}
