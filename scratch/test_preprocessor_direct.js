require('dotenv').config({ path: '.env.local' });

const apiKey = process.env.GOOGLE_CLOUD_API_KEY || process.env.GOOGLE_API_KEY;

async function testOcr(fileUrl, mimeType) {
  console.log(`Testing OCR for URL: ${fileUrl}, mimeType: ${mimeType}`);
  console.log(`API Key present: ${!!apiKey}`);

  if (!apiKey || apiKey === 'your_google_cloud_api_key_here') {
    console.error('GOOGLE_CLOUD_API_KEY is not configured in .env.local');
    return;
  }

  try {
    const response = await fetch(fileUrl);
    if (!response.ok) {
      throw new Error(`Failed to download file. Status: ${response.status}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    const base64Data = Buffer.from(arrayBuffer).toString('base64');
    const isPdf = mimeType === 'application/pdf' || fileUrl.toLowerCase().split('?')[0].endsWith('.pdf');

    let rawOcrText = '';
    let pageCount = 1;
    let confidence = 0.95;
    const detectedLanguages = new Set();

    if (isPdf) {
      console.log('Sending to files:annotate...');
      const apiUrl = `https://vision.googleapis.com/v1/files:annotate?key=${apiKey}`;
      const payload = {
        requests: [
          {
            inputConfig: {
              content: base64Data,
              mimeType: 'application/pdf',
            },
            features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
            pages: [1, 2, 3],
          },
        ],
      };

      const apiResponse = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!apiResponse.ok) {
        throw new Error(`Vision PDF OCR failed: ${apiResponse.statusText}. Details: ${await apiResponse.text()}`);
      }

      const data = await apiResponse.json();
      const fileResponses = data.responses?.[0]?.responses;
      if (fileResponses && Array.isArray(fileResponses)) {
        pageCount = fileResponses.length;
        const textParts = [];
        let totalConfidence = 0;
        let confidenceCount = 0;

        for (const pageRes of fileResponses) {
          if (pageRes.error) {
            throw new Error(`Page OCR error: ${pageRes.error.message}`);
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
        throw new Error('Empty PDF OCR responses');
      }
    } else {
      console.log('Sending to images:annotate...');
      const apiUrl = `https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`;
      const payload = {
        requests: [
          {
            image: { content: base64Data },
            features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
            imageContext: { languageHints: ['he', 'en'] },
          },
        ],
      };

      const apiResponse = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!apiResponse.ok) {
        throw new Error(`Vision Image OCR failed: ${apiResponse.statusText}. Details: ${await apiResponse.text()}`);
      }

      const data = await apiResponse.json();
      const imageResponse = data.responses?.[0];
      if (imageResponse) {
        if (imageResponse.error) {
          throw new Error(`Image OCR error: ${imageResponse.error.message}`);
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
        }
      }
    }

    console.log('\n--- SUCCESS ---');
    console.log(`Pages: ${pageCount}`);
    console.log(`Confidence: ${confidence}`);
    console.log(`Detected Languages: ${Array.from(detectedLanguages).join(', ')}`);
    console.log('--- Text Preview (first 200 chars) ---');
    console.log(rawOcrText.substring(0, 200));
  } catch (error) {
    console.error('OCR Test failed with error:', error.message);
  }
}

// Run test with a sample file if you want, otherwise we'll run it to check error behavior
testOcr('https://upload.wikimedia.org/wikipedia/commons/4/47/PNG_transparency_demonstration_1.png', 'image/png');
