# Project Context & AI Guidelines: Invoice Scan (Shtibel1)

Welcome! This document serves as the source of truth for the codebase architecture, design choices, tech stack, and development guidelines for the Shtibel1 Invoice Scan & Management project. Read this document and the detailed guides in the `docs/` folder before making any changes.

### 📚 Detailed Reference Guides
- [Database Schema (docs/db_schema.md)](file:///c:/Users/nadavs.CITYSHOB/Desktop/invoice-scan/docs/db_schema.md): Detailed schemas, tables, relationships, and JSONB formats.
- [Supplier Rules & Auto-Approve (docs/supplier_automation.md)](docs/supplier_automation.md): Per-supplier defaults, precedence, auto-approve eligibility and opt-in.
- [Authentication & Tenancy (docs/auth.md)](docs/auth.md): Login, offices (organizations) + memberships, RLS model, route guards, inviting members.
- [Feature Flags & Review Loop (docs/feature_flags.md)](docs/feature_flags.md): Per-office feature flags ("תכונות ניסיוניות") and the accountant "החזר ללקוח" flow (flag `accountant_review_loop`).
- [Export Plugins & Integrations (docs/integrations.md)](docs/integrations.md): Bookkeeping export plugins, per-client encrypted config, idempotent export flow, logging HTTP client, integration logs + retention.
- [Coding Standards & AI Guidelines (docs/coding_standards.md)](file:///c:/Users/nadavs.CITYSHOB/Desktop/invoice-scan/docs/coding_standards.md): Mandatory conventions, type-safety, import rules, and Git commit guidelines.

---

## 🚀 Tech Stack
- **Framework:** Next.js (App Router, Tailwind CSS, TypeScript).
- **Database & Storage:** Supabase (PostgreSQL database & Storage buckets for raw invoices).
- **AI Agent Pipeline:** LangGraph (`StateGraph` with a memory saver checkpointer).
- **LLM Provider:** Anthropic SDK (Claude Sonnet for extraction and multi-invoice boundary detection).
- **OCR Engine:** Google Cloud Vision API (Document Text Detection).
- **PDF Manipulation & Rendering:** `pdf-lib` (splitting/page management) and `react-pdf` (client-side page canvas rendering).

---

## 📁 Project Structure

```
src/
├── app/                  # Next.js pages & API routes
│   ├── (dashboard)/      # Layouts and routes for Clients, Mappings, Upload, and Review
│   └── api/              # API endpoints (/api/export, /api/invoices, /api/ingest/{email,whatsapp}, /api/clients, /api/suppliers/search-vat, /api/mock-db)
├── agents/               # LangGraph AI Pipeline Nodes
│   ├── supervisor/       # Orchestrator & StateGraph definition
│   ├── preprocessor/     # Google Vision OCR (full text, per-page text, word bboxes)
│   ├── splitter/         # Multi-invoice PDF boundary detection (heuristics + Claude tool-use)
│   ├── extraction/       # Anthropic Claude 3.5 Sonnet extraction engine
│   ├── validation/       # Business rules & DB duplicate checks
│   └── approval/         # Human-in-the-Loop approval node & resumption
├── components/           # UI Components (UploadZone, InvoiceTable, SplitPane, Integrations)
├── integrations/         # Export plugin framework: types, registry, logging HTTP client, redaction, retry, idempotency, runner; plugins/<id>/ (movein, excel, webhook) - see docs/integrations.md
├── lib/                  # Services & Exporters (e.g., movein.ts for Move-in ERP format; ingest.ts = single ingestion entry point for upload/email/WhatsApp, see docs/ingestion.md)
├── shared/               # TypeScript interfaces (types.ts) and schemas
└── utils/                # Utility helpers (e.g., encoding.ts, businessLookup.ts for Gov.il searches)
```

---

## 🔐 Authentication & Tenancy

Supabase Auth with cookie sessions (`@supabase/ssr`). An **organization** is a bookkeeping office; users join it through `memberships` (owner | member) and every `clients` row has `org_id`. Details: [docs/auth.md](docs/auth.md).
- `src/proxy.ts` (Next 16 Proxy, formerly middleware): session refresh; dashboard pages → `/login?next=`, `/api/*` → 401. Public: marketing pages, `/login`, `/signup`, `/auth/*`, `/api/lead`, `/api/ingest/{email,whatsapp}` (list in `src/lib/routeAccess.ts`).
- `src/lib/auth.ts`: `requireUser`, `requireClientAccess`, `requireInvoiceAccess`, `requireBankTransactionAccess`, `requireOrgOwner`, `accessibleClientIds`. **Every new API route must call one of these before using the service-role client** (`@/lib/supabase`, server-only). Never trust `clientId`/`tenantId` from the body without a check.
- Browser components use `@/utils/supabase/client` (anon key + user session → RLS). RLS policies (migration `20261030140000_auth_tenancy.sql`) scope every table by org membership; anon has no access.
- Mock mode (no Supabase env, not production) skips auth; production without env fails closed (`src/lib/supabaseConfig.ts`).

---

## 🔄 The AI Agent Pipeline (LangGraph Flow)

The processing pipeline is defined in [supervisor/index.ts](file:///c:/Users/nadavs.CITYSHOB/Desktop/invoice-scan/src/agents/supervisor/index.ts) and runs in the following order:

1. **`init_rules`:** Fetch client-specific dynamic rules from the database.
2. **`preprocess`:** Run Google Vision OCR (per page). For multi-page PDFs the splitter agent detects document boundaries: a cheap heuristic pre-check (single page, unreadable pages, consistent "עמוד X מתוך N" markers) decides without the LLM where it can; otherwise Claude (tool `report_document_boundaries`) groups pages into documents with a confidence. Ranges are validated by the pure helpers in `src/shared/documentSplit.ts`.
   - **Default:** the file is kept whole, the suggestion is stored in `extracted_data.split_suggestion`, `validate` adds a warning and forces manual review, and the review screen shows a banner that pre-fills the existing split dialog.
   - **Auto-split:** only when `AUTO_SPLIT_ENABLED` (in `documentSplit.ts`, default `false`) and confidence ≥ `AUTO_SPLIT_MIN_CONFIDENCE` (0.9): the PDF is split, parts are uploaded, and child pipelines are triggered.
3. **`extract`:** Use Claude 3.5 Sonnet with a tool-use definition (`save_invoice_data`) to extract invoice fields, bounding box coordinates (bboxes), line items (up to 50, `shared/lineItems.ts`) and a per-field 0-1 confidence map (`field_confidence`, `shared/confidence.ts`).
   - **Per-supplier few-shot ("instant learning"):** before the call, VAT-id candidates in the OCR text (8/9 digits passing the checksum) are matched against `supplier_vat_id` of human-reviewed invoices (`reviewed_at` set). Up to 3 recent ones with stored `ocr_text` (same client first; other clients only without bank details, and never for the client's own VAT id — recognized as the buyer id printed on its reviewed invoices from 2+ suppliers) are added to the prompt as truncated OCR + approved values, with fields from `invoice_corrections` marked as previously misread. Pure logic in `src/shared/fewshot.ts`, DB loader in `src/lib/fewshot.ts`; best-effort (any failure → no examples). The save nodes persist `invoices.ocr_text` and `fewshot_example_count` / `fewshot_example_ids`; compare accuracy in the `fewshot_accuracy` view. Set `EXTRACTION_FEWSHOT=off` to disable.
4. **`validate`:** Run calculations, Luhn checksum for Israeli VAT IDs (H.P.), whitelist category checks, database duplication checks, and composed VAT ID identification (from the invoice, supplier table, and Gov.il API web search). Line items are checked against the invoice amounts (±1 ILS) and for mixed VAT — as warnings only (but they block supplier auto-approve).
   - `ai_confidence` is computed by `computeConfidence` in `shared/confidence.ts` (field presence weighted by the model's field confidence, minus validation penalties) at save and again at approval. Records without `field_confidence` score exactly as before. Fields the model scored below 0.7 also block supplier auto-approve (except fields a supplier rule filled in).
   - **Duplicate detection** (`src/shared/duplicates.ts` rules, `src/lib/duplicates.ts` DB access): flags `same_file` (SHA-256 `invoices.file_hash`, set at upload/split time by `src/lib/fileHash.ts`), `same_number` (same supplier + normalized invoice number) and `fuzzy` (same supplier, total within 1 ILS, date within 3 days). Rejected invoices are ignored; pairs dismissed in the review UI (`duplicate_dismissals`, `POST /api/invoices/[id]/duplicates/dismiss`) are never flagged again. Results go to `validation_flags.duplicate_matches`. Candidates come from the `find_duplicate_candidates` RPC, with a client-scan fallback (mock DB / migration not applied).
5. **`save_review` / `save_success`:** Invoices route to `save_review` (status `review`, execution interrupts) unless the client opted the supplier into auto-approve and every validation check passed (including the duplicate check: any duplicate match, or a duplicate check that was skipped/failed, blocks auto-approve); then `save_success` approves it without `reviewed_at`. Both nodes write the AI output to `extracted_data` and the AI output + supplier-rule defaults to `validated_data`. See [docs/supplier_automation.md](docs/supplier_automation.md).
6. **`approval`:** `POST /api/invoices/[id]/approve` accepts only invoices in `review` (409 otherwise), validates `validated_data` on the server (`src/shared/approvalValidation.ts`: numeric amounts, real ISO date, net + VAT = total within 1 ILS, VAT-id checksum, 9-digit allocation number, required when `isAllocationRequired`), merges it over the stored data, clears `validation_flags.auto_approved` and writes status + data + `reviewed_at` in one conditional update (`.in('status', ['review'])`). It then closes the paused graph thread (`resumeApproval`).
7. **Status state machine** (`src/shared/invoiceStatus.ts`, mirrored by the `invoices_status_check` constraint and `invoices_status_guard` trigger of migration `20261030160000_qa_status_integrity.sql`): processing → review | approved (auto) | error; review → approved | rejected | returned; approved → exported | returned; error → processing (`POST …/retry`) | rejected (`POST …/reject`) | deleted (`DELETE /api/invoices/[id]`); approved / rejected / returned / exported → review only via `POST …/reopen` (exported: office owner only, logged in `invoice_status_events`). Status changes go through these API routes; browser sessions cannot change status / approval fields directly.

---

## 🏦 Bank Statement Matching (`/bank`)

Bank / credit-card statements are matched against approved invoices; unmatched debits form the "missing invoices" list the accountant sends to the client.
- **Import:** the browser reads CSV/XLS/XLSX (`src/lib/bankStatementFile.ts`), the user confirms the column mapping, and pure helpers in `src/shared/bankStatement.ts` normalize dates (dd/mm/yyyy, yyyy-mm-dd, Excel serials) and amounts ('1,234.56', '(123)', '123-'). Rows are stored in `bank_transactions` (negative amount = debit); `bankDedupeKeys()` + a unique index make re-imports idempotent.
- **Matching:** `autoMatch()` in `src/shared/bankMatch.ts` pairs debits with approved/exported invoices of the same client (total within 0.5 ILS, charge date between invoice date -7 and +90 days, ranked by supplier-name tokens in the description, then date). Ties are left unmatched with candidates; an invoice is never matched twice (also enforced by a partial unique index).
- **Persistence:** `src/lib/bankTransactions.ts` (repository; works with the mock DB) behind `/api/bank`, `/api/bank/import`, `/api/bank/match`, `/api/bank/transactions/[id]`. Migration: `supabase/migrations/20261030136000_bank_transactions.sql`.

---

## 🛠️ Formatting & Hebrew Encoding Rules (Critical)
Older Israeli ERP systems (such as Move-in) require single-byte Windows-1255 encoding and **Visual Hebrew** (where letters are written backwards but numbers and English stay LTR).
- When formatting text for export file generation:
  - Reverse Hebrew strings using `toVisualHebrew(str)` from [encoding.ts](file:///c:/Users/nadavs.CITYSHOB/Desktop/invoice-scan/src/utils/encoding.ts).
  - Encode the output into Windows-1255 byte buffer using `encodeWindows1255(str)`.
- **Do not** write raw Hebrew strings directly to the exported buffers without applying this formatting.

---

## 📐 Coding & Design Guidelines (SOLID)

### 1. Single Responsibility (SRP)
- Keep UI components visual. Avoid heavy calculations or direct API calling inside views. Extract them into custom hooks.
- Move utility helpers (like PDF processing or token cost calculators) out of agent nodes into `src/utils/`.

### 2. Open-Closed (OCP)
- **Exporters:** Exporters should implement a shared interface so new file formats can be added without modifying the route endpoint.
- **Validation Rules:** Avoid hardcoding validations directly inside `validateInvoice`. Use a rule-engine design where new rules can be added dynamically.

### 3. Dependency Inversion (DIP)
- Do not import the concrete `supabase` client directly inside business logic. Instead, abstract database queries behind database services or repository classes. This enables mock testing.

---

## 🔒 Environment Variables Checklist
Make sure the following environment variables are present in `.env.local`:
- `NEXT_PUBLIC_API_URL`
- `GOOGLE_CLOUD_API_KEY` (or `GOOGLE_API_KEY`)
- `ANTHROPIC_API_KEY`
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_KEY` (or `SUPABASE_SERVICE_ROLE_KEY`) - required since the auth/tenancy migration (anon has no table access)
- `NEXT_PUBLIC_SITE_URL` (optional, origin for invite-email redirects)
- `EXTRACTION_FEWSHOT` (optional, `off` disables per-supplier few-shot examples)
- `INTEGRATIONS_ENCRYPTION_KEY` (32 random bytes, base64; AES-256-GCM key for per-client integration credentials, see [docs/integrations.md](docs/integrations.md))

Optional ingestion channels (off unless set, see [docs/ingestion.md](docs/ingestion.md)):
- `INGEST_EMAIL_SECRET`, `INBOUND_EMAIL_DOMAIN` (inbound email webhook)
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WEBHOOK_URL`, `TWILIO_WHATSAPP_NUMBER` (WhatsApp via Twilio)

Feature flags / review loop (see [docs/feature_flags.md](docs/feature_flags.md)):
- `FEATURE_FLAGS_DEFAULT` (optional, comma-separated flags on by default for every office, e.g. `accountant_review_loop`; offices can override)
- `CLIENT_NOTIFY_EMAIL_FROM` (optional, SES-verified sender for "returned to client" emails; falls back to `CONTACT_FROM_EMAIL`)
- `TWILIO_WHATSAPP_FROM` (optional, WhatsApp sender for client notifications; falls back to `TWILIO_WHATSAPP_NUMBER`)

---

## 🤖 AI Agent Protocol & Operational Rules
1. **Self-Documenting Updates:** After any code change, feature addition, or architectural refactor, the agent **MUST** update this `PROJECT_CONTEXT.md` file if there are any new directories, rules, tech stack additions, or flow modifications. Keep this document up-to-date and accurate.
2. **Auto-Git Push & Versioning:** Once a task is completed, fully verified, and the user's requirements are met, the agent **MUST** run `npm run bump-version` to bump the project patch version and update the UI version display. After bumping, the agent must commit all changes (including the version files) and push them to GitHub.
