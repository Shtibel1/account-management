---
name: invoice-pipeline
description: How the LangGraph invoice pipeline works (supervisor graph, OCR preprocessor, multi-invoice PDF splitting, Claude extraction, validation routing, retry, human-in-the-loop approval, cost tracking). Use when changing anything under src/agents/, the process/approve/split API routes, LLM prompts or models, or debugging an invoice stuck in processing/review/error.
---

# Invoice pipeline (src/agents/)

Last verified against code: 2026-10-29

## Flow

`runOrchestrationPipeline(invoiceId, fileUrl, mimeType, tenantId)` in `src/agents/supervisor/index.ts` invokes the compiled graph with `thread_id = invoiceId`.

```
__start__ → init_rules → preprocess → extract → validate ─┬─ not_an_invoice ──────────→ save_error → END
                                         ▲                ├─ !math_ok && retryCount<1 → extract (retry, vision on)
                                         └────────────────┤
                                                          ├─ requires_manual_review ──→ save_review → [interrupt] approval → END
                                                          └─ else ───────────────────→ save_success → END
```

| Node | Code | Does |
|---|---|---|
| `init_rules` | `getTenantRules` (supervisor) | Reads `clients.rules` (JSONB) and merges it over the defaults. Falls back to defaults on any error |
| `preprocess` | `src/agents/preprocessor/index.ts` | Google Vision `DOCUMENT_TEXT_DETECTION`. PDFs are OCR'd in batches of 5 pages in parallel (`files:annotate`), images through `images:annotate`. It returns text, word-level bboxes (normalized 0–1) and `ocrOpCount = ceil(pages/5)` |
| ↳ split | `detectInvoiceSplits` (preprocessor) and the split block in the supervisor's `preprocess` node | Multi-page PDF → Claude Haiku returns `{splits:[{start_page,end_page}]}`. Part 1 replaces the current invoice row's file. Parts 2+ get **new invoice rows** and recursive `runOrchestrationPipeline` calls. If anything fails, it continues with the original PDF |
| `extract` | `src/agents/extraction/index.ts` | Claude Sonnet with the forced tool `save_invoice_data`. Text-only by default. It switches to vision (`useVisionFallback`) on retry or when there is no OCR text. Bboxes are then **overwritten** by `matchBboxesWithOcr` (supervisor) using the OCR word boxes |
| `validate` | `src/agents/validation/index.ts` | Deterministic. See the `israeli-invoice-rules` skill |
| `save_review` | supervisor | Writes `extracted_data`, `validated_data`, `status:'review'`, `ai_confidence` |
| `approval` | `src/agents/approval/index.ts` | Runs only after `resumeApproval` (from `POST /api/invoices/[id]/approve`). Writes `validated_data` and `status:'approved'` |
| `save_error` | supervisor | `status:'error'` + `error_message` |

Models are hardcoded in the agent files: extraction `claude-sonnet-4-5-20250929`, split detection `claude-3-haiku-20240307`. The cost math in `calculateEstimatedCost` assumes Sonnet pricing ($3 / $15 per MTok) plus $0.0015 per OCR operation. **If you change a model, update the pricing too.**

## Rules

- Every node that can fail must leave the DB row in a terminal state (`review` / `approved` / `error`). An invoice stuck in `processing` is a bug.
- State channels are declared in `new StateGraph<any>({ channels: ... })`. A new state field needs a channel there **and** a field on `PipelineState` in `src/shared/types.ts`.
- Prompts are in Hebrew and target Israeli invoices. Keep the field set in `TOOL_DEFINITION`, `ExtractedData`, `ExtractedDataSchema` and `BboxMap` aligned.
- Log with a `[Supervisor]`, `[Preprocessor]` or `[Extraction]` prefix, matching the existing style.

## Gotchas

- **Manual review is forced.** `requiresManualReview = true` in validation, so `save_success` is effectively dead code. `maxAmountForAutoApprove` only adds a rule-violation message.
- **The retry almost never fires.** `runEdgeCaseHandlers` auto-corrects `amount_before_vat = total − vat` *before* `checkMath`, so `math_ok` is false only in rare cases. The retry cap is `retryCount < 1` (one retry), while `supervisor/agent.md` says 2. The code is current behavior; ask Nadav before changing either one.
- **Approval depends on an in-memory checkpointer.** `MemorySaver` lives in the server process. If the server restarted, or a different serverless instance (Amplify) handles `/approve`, the checkpoint for that `thread_id` is gone. Unverified whether this throws or silently does nothing; check this first when "approve doesn't change status".
- **Vision fallback on PDFs:** `extractInvoiceData` sends the downloaded file as an `image` block with `media_type` forced to `image/jpeg` when the mime type isn't `image/*`. A PDF retry therefore sends PDF bytes labelled as JPEG. Treat it as suspect when debugging extraction errors on retry.
- `findExactBbox` returns the **first** OCR word that matches. Repeated values (for example, the same amount appearing twice) may highlight the wrong place.
- Split children run inside the parent's `preprocess` node (`await Promise.all(childPromises)`), so one HTTP request can process many invoices. Watch for timeouts.
- `computeConfidence` (supervisor) and the confidence formula in `approvalNode` are different formulas.

## Verify

`npx tsc --noEmit`. For a real run: `npm run dev`, upload from `/upload`, and watch the `[Supervisor]` logs. `scratch/test_preprocessor*.js` exercise OCR directly and need keys in `.env.local`. See the `verify-changes` skill.

---
Finished the task? Run the `self-improve` skill: fix anything above that was wrong and add new gotchas.
