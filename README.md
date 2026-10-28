# Invoice Scan — Hebrew invoice OCR & bookkeeping pipeline

**סריקה בעברית** is a full-stack Next.js app that turns scanned Hebrew invoices and receipts into validated, ready-to-import accounting entries for bookkeeping firms. Accountants upload PDFs or photos per client, a multi-agent AI pipeline extracts and verifies the data, and a reviewer approves each document side-by-side with the original before export.

## Architecture

```
Upload (PDF / image) ──► Supabase Storage
        │
        ▼
 Supervisor agent (LangGraph)
   ├─ Preprocessor  – Google Cloud Vision DOCUMENT_TEXT_DETECTION, word-level bounding boxes
   ├─ Extraction    – LLM (Claude / Gemini / OpenAI) → typed invoice JSON (Zod schemas)
   ├─ Validation    – VAT-ID checksum, totals & VAT math, supplier lookup in the
   │                  Israeli Companies Registrar open-data API, per-client mappings
   └─ Approval      – maps supplier / expense category → ledger account codes
        │
        ▼
 Review UI (split pane: document viewer with highlighted fields + editable form)
        │
        ▼
 Export (e.g. MoveIn / Excel via xlsx)
```

Each agent lives in `src/agents/<name>/` with its prompt/spec in `agent.md` and logic in `index.ts`. Extracted fields are matched back to OCR word boxes so the reviewer sees exactly where each value came from.

## Stack

- **Next.js 16 (App Router), React 18, TypeScript, Tailwind CSS**
- **LangGraph / LangChain** with Anthropic, Google GenAI and OpenAI models
- **Google Cloud Vision** for Hebrew OCR, `pdf-lib` / `react-pdf` for documents
- **Supabase** (Postgres + Storage) for clients, invoices and mappings
- **AWS Amplify** hosting, **AWS SES** for marketing-site lead emails
- **Zod** shared schemas (`src/shared`)

## Routes

| Route | Purpose |
|---|---|
| `/` | Hebrew marketing site |
| `/order` | Lead / order form (sent via AWS SES) |
| `/privacy` | Privacy policy |
| `/clients` | Manage bookkeeping clients |
| `/upload` | Bulk upload invoices per client |
| `/review`, `/review/[id]` | Review queue and side-by-side validation |
| `/mappings` | Supplier / category → account-code mappings |

API routes under `src/app/api/`: `invoices` (upload, upload-url, process, split, approve), `suppliers/search-vat`, `export`, `lead`.

## Local setup

```bash
npm install
cp .env.example .env.local   # or create it with the variables below
npm run dev                  # http://localhost:3001
```

Environment variables (names only):

- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_CLOUD_API_KEY`
- `AWS_REGION` / `AWS_SES_REGION`, `CONTACT_FROM_EMAIL`, `CONTACT_TO_EMAIL`

A mock Supabase client (`src/utils/supabase/mockClient.ts`) allows running the UI without a database.

## Repository layout

```
src/agents/      AI pipeline (supervisor, preprocessor, extraction, validation, approval)
src/app/         Next.js routes – (dashboard), (marketing), api
src/components/  UI: InvoiceTable, SplitPane viewer/form, UploadZone
src/lib/         API client, exporters
src/shared/      Zod schemas & types
docs/            DB schema and coding standards
```
