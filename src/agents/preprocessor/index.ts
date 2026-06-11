import type { OcrMetadata } from '@/shared/types';

export async function preprocessInvoice(
  fileUrl: string,
  mimeType: string
): Promise<{
  rawOcrText: string;
  ocrMetadata: OcrMetadata;
  ocrOpCount: number;
}> {
  console.log(`[Preprocessor] Starting Google Cloud Vision OCR for URL: ${fileUrl}, mimeType: ${mimeType}`);

  const apiKey = process.env.GOOGLE_CLOUD_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error('Google Cloud Vision API key is not configured. Please set GOOGLE_CLOUD_API_KEY in your .env.local file.');
  }

  // 1. Fetch file content from signed URL
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

  if (isPdf) {
    console.log(`[Preprocessor] Processing as PDF via files:annotate`);
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
          pages: [1, 2, 3, 4, 5], // Process first 5 pages synchronously
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
      throw new Error(`Google Cloud Vision PDF OCR request failed: ${apiResponse.statusText}. Details: ${errText}`);
    }

    const data = await apiResponse.json();
    const fileResponses = data.responses?.[0]?.responses;

    if (fileResponses && Array.isArray(fileResponses)) {
      pageCount = fileResponses.length;
      const textParts: string[] = [];
      let totalConfidence = 0;
      let confidenceCount = 0;

      for (const pageRes of fileResponses) {
        if (pageRes.error) {
          throw new Error(`Google Cloud Vision page OCR error: ${pageRes.error.message}`);
        }
        if (pageRes.fullTextAnnotation) {
          if (pageRes.fullTextAnnotation.text) {
            textParts.push(pageRes.fullTextAnnotation.text);
          }
          if (pageRes.fullTextAnnotation.pages) {
            for (const page of pageRes.fullTextAnnotation.pages) {
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
          }
        }
      }

      rawOcrText = textParts.join('\n\n');
      if (confidenceCount > 0) {
        confidence = totalConfidence / confidenceCount;
      }
    } else {
      throw new Error('Google Cloud Vision returned empty PDF OCR responses');
    }
  } else {
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
      } else {
        console.warn('[Preprocessor] Image annotation returned empty result');
      }
    } else {
      throw new Error('Google Cloud Vision returned empty Image OCR responses');
    }
  }

  // Normalize language codes (e.g. iw to he)
  const normalizedLanguages = Array.from(detectedLanguages).map((lang) => 
    lang === 'iw' ? 'he' : lang
  );

  // If no languages were detected, fallback to he
  if (normalizedLanguages.length === 0) {
    normalizedLanguages.push('he');
  }

  console.log(`[Preprocessor] OCR completed successfully. Pages: ${pageCount}, confidence: ${confidence.toFixed(2)}, languages: ${normalizedLanguages.join(', ')}`);

  return {
    rawOcrText,
    ocrMetadata: {
      pageCount,
      detectedLanguages: normalizedLanguages,
      confidence,
    },
    ocrOpCount: 1,
  };
}
