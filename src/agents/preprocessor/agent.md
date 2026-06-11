# Preprocessor Agent Manifest

## Role & Objective
The Preprocessor Agent acts as the ingestion node of the invoice pipeline. It is responsible for:
1. Receiving the invoice file reference (`fileUrl` and `mimeType`).
2. Performing a fast, deterministic, high-accuracy OCR extraction of the raw text and spatial tokens.
3. Accounting for bilingual right-to-left (RTL) reading directions (Hebrew + English).
4. Updating the LangGraph state with `rawOcrText` and associated OCR metrics, incrementing the OCR operation counter in `costMetrics`.

In this implementation, the preprocessor uses a robust deterministic parsing utility that simulates or interfaces with a cloud-based OCR engine (e.g. Google Cloud Vision or Document AI API).

## Input/Output Contract

### Input Context
- `fileUrl`: `string` (URL to the invoice document)
- `mimeType`: `string` (MIME type of the document, e.g. `application/pdf`, `image/png`, `image/jpeg`)

### Output State Fields
The agent updates the following shared LangGraph state fields:
- `rawOcrText`: `string` (The full reconstructed plain text representation of the document)
- `ocrMetadata`: `OcrMetadata` (Details about pages and confidence)
- `costMetrics.ocrOpCount`: `number` (Increments the cumulative count of OCR operations performed; typically +1 per run)

```typescript
export interface OcrMetadata {
  pageCount: number;
  detectedLanguages: string[]; // e.g. ["he", "en"]
  confidence: number;          // Overall OCR confidence (0.0 to 1.0)
}
```

## Reading Direction & Layout Rules
- **BiDi (Bidirectional) Text Reorder:**
  - Hebrew and English mixed lines must be ordered in logical reading layout. When parsing tabular row contents, columns must be separated by space/tab/newline while retaining left-to-right alignment of numbers and right-to-left alignment of Hebrew description strings.
- **Error Handling:**
  - If the document cannot be processed, the API key is missing, or the Google Cloud Vision request fails, a detailed error is thrown, and the pipeline routes to `save_error`.

