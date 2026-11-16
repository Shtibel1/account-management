# Splitter Agent Manifest

## Role & Objective
The Splitter Agent decides whether a multi-page PDF actually holds several separate documents (e.g. a batch of supplier invoices scanned into one file) and, if so, which pages belong together. It runs inside the supervisor's `preprocess` node, right after OCR.

## How It Decides
1. **Heuristic pre-check (no LLM)** — `precheckSplit` in `src/shared/documentSplit.ts`:
   - A single page → no split.
   - Fewer than two pages with readable OCR text → no split (nothing to compare).
   - Every page carries a consistent "עמוד X מתוך N" / "Page X of N" marker → the grouping follows the markers (one document → no split; several → suggestion with confidence 0.92, source `page_markers`).
2. **LLM** — otherwise Claude (same model as extraction) is called with forced tool-use (`report_document_boundaries`), the per-page OCR text (head + tail of each page, within a character budget) and the heuristic hints (page markers, invoice numbers per page). Files over 60 pages are left to the reviewer.
3. **Validation** — `parseLlmSplitResult` rejects anything that isn't 1-based, contiguous, non-overlapping and covering every page. The overall confidence is capped by the weakest document.

The agent never throws: a missing API key, an API error or invalid ranges simply produce no suggestion.

## Input/Output Contract

### Input
- `pageTexts`: `string[]` — OCR text per page, in page order (from the preprocessor).

### Output
```typescript
{
  suggestion: SplitSuggestion | null; // only when more than one document was detected
  inputTokens: number;
  outputTokens: number;
}
```
`SplitSuggestion` (see `src/shared/documentSplit.ts`) holds `page_count`, `documents` (`start_page`, `end_page`, `confidence`, `reason`), overall `confidence`, `source` and `detected_at`.

## What Happens With the Suggestion
- **Default (`AUTO_SPLIT_ENABLED = false`)**: the file stays whole. The suggestion is stored in `extracted_data.split_suggestion`, the validate node adds a warning and forces manual review, and the review screen shows a banner that pre-fills the manual split dialog with the suggested ranges.
- **Auto-split** (`AUTO_SPLIT_ENABLED = true` and confidence ≥ `AUTO_SPLIT_MIN_CONFIDENCE`, 0.9): the supervisor splits the PDF and runs a child pipeline per part.
