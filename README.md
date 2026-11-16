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
| `/login`, `/signup` | Sign in (password or magic link) / open a new office (see [docs/auth.md](docs/auth.md)) |
| `/auth/callback`, `/auth/complete` | Landing for Supabase auth emails (confirmation, magic link, invite) |
| `/clients` | Manage bookkeeping clients, their inbound email address and WhatsApp phones |
| `/upload` | Bulk upload invoices per client |
| `/review`, `/review/[id]` | Review queue and side-by-side validation |
| `/mappings` | Supplier / category → account-code mappings |
| `/bank` | Bank / credit-card statement import, invoice matching and the "missing invoices" list |

Everything except the marketing pages, `/login`, `/signup`, `/auth/*`, `/api/lead` and the ingestion webhooks requires a signed-in user (`src/proxy.ts`); each API route also checks that the client / invoice / bank line belongs to one of the user's offices (`src/lib/auth.ts`). Data is isolated per office (organization) by Supabase RLS - see [docs/auth.md](docs/auth.md).

API routes under `src/app/api/`: `me` (current user + offices), `org/members` (owner-only add/invite/remove members), `invoices` (upload, upload-url, process, split, approve, duplicates/dismiss), `ingest/email` and `ingest/whatsapp` (inbound channels, see [docs/ingestion.md](docs/ingestion.md)), `clients` (channels, contacts), `suppliers` (search-vat, automation, rules/apply), `export`, `lead`, `bank` (overview, import, match, transactions/[id]), `integrations` (plugins, export, exports, logs) and `clients/[id]/integrations` (per-client export plugin settings + connection test, see [docs/integrations.md](docs/integrations.md)).

## Local setup

```bash
npm install
cp .env.example .env.local   # or create it with the variables below
npm run dev                  # http://localhost:3001
```

Environment variables (names only):

- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY` (or `SUPABASE_SERVICE_ROLE_KEY`; required - anon has no table access), `NEXT_PUBLIC_SITE_URL` (public origin, e.g. `https://app.example.com`: auth-callback redirects and invite links; behind Amplify the request URL is `localhost:3000`, so set it on every branch), optional `SITE_ALLOWED_HOSTS` (comma-separated hosts whose `X-Forwarded-Host` is trusted when `NEXT_PUBLIC_SITE_URL` is unset), optional `LEAD_RATE_SALT` (salt of the IP hash used by the lead-form rate limit)
- `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_CLOUD_API_KEY`
- `AWS_REGION` / `AWS_SES_REGION`, `CONTACT_FROM_EMAIL`, `CONTACT_TO_EMAIL`
- `INTEGRATIONS_ENCRYPTION_KEY` - 32 random bytes, base64 (`openssl rand -base64 32`); encrypts per-client bookkeeping credentials (export plugins, see [docs/integrations.md](docs/integrations.md))
- Optional ingestion channels: `INGEST_EMAIL_SECRET`, `INBOUND_EMAIL_DOMAIN`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WEBHOOK_URL`, `TWILIO_WHATSAPP_NUMBER` - see [docs/ingestion.md](docs/ingestion.md)

A mock Supabase client (`src/utils/supabase/mockClient.ts`) allows running the UI without a database; in that local mock mode there is no login. In production a missing Supabase config fails closed (503).

## Repository layout

```
src/agents/      AI pipeline (supervisor, preprocessor, splitter, extraction, validation, approval)
src/app/         Next.js routes – (dashboard), (marketing), api
src/components/  UI: InvoiceTable, SplitPane viewer/form, UploadZone
src/lib/         API client, exporters
src/shared/      Zod schemas & types
docs/            DB schema, coding standards, ingestion channel setup, auth & tenancy (auth.md)
```
