# Project Context & AI Guidelines: Invoice Scan (Shtibel1)

Welcome! This document serves as the source of truth for the codebase architecture, design choices, tech stack, and development guidelines for the Shtibel1 Invoice Scan & Management project. Read this document and the detailed guides in the `docs/` folder before making any changes.

### 📚 Detailed Reference Guides
- [Database Schema (docs/db_schema.md)](file:///c:/Users/nadavs.CITYSHOB/Desktop/invoice-scan/docs/db_schema.md): Detailed schemas, tables, relationships, and JSONB formats.
- [Coding Standards & AI Guidelines (docs/coding_standards.md)](file:///c:/Users/nadavs.CITYSHOB/Desktop/invoice-scan/docs/coding_standards.md): Mandatory conventions, type-safety, import rules, and Git commit guidelines.

---

## 🚀 Tech Stack
- **Framework:** Next.js (App Router, Tailwind CSS, TypeScript).
- **Database & Storage:** Supabase (PostgreSQL database & Storage buckets for raw invoices).
- **AI Agent Pipeline:** LangGraph (`StateGraph` with a memory saver checkpointer).
- **LLM Provider:** Anthropic SDK (Claude 3.5 Sonnet for extraction, Claude Haiku for invoice splitting).
- **OCR Engine:** Google Cloud Vision API (Document Text Detection).
- **PDF Manipulation:** `pdf-lib` (splitting/page management).

---

## 📁 Project Structure

```
src/
├── app/                  # Next.js pages & API routes
│   ├── (dashboard)/      # Layouts and routes for Clients, Mappings, Upload, and Review
│   └── api/              # API endpoints (/api/export, /api/invoices, /api/mock-db)
├── agents/               # LangGraph AI Pipeline Nodes
│   ├── supervisor/       # Orchestrator & StateGraph definition
│   ├── preprocessor/     # OCR & Smart Invoice Splitting logic
│   ├── extraction/       # Anthropic Claude 3.5 Sonnet extraction engine
│   ├── validation/       # Business rules & DB duplicate checks
│   └── approval/         # Human-in-the-Loop approval node & resumption
├── components/           # UI Components (UploadZone, InvoiceTable, SplitPane)
├── lib/                  # Services & Exporters (e.g., movein.ts for Move-in ERP format)
├── shared/               # TypeScript interfaces (types.ts) and schemas
└── utils/                # Utility helpers (e.g., encoding.ts for Hebrew support)
```

---

## 🔄 The AI Agent Pipeline (LangGraph Flow)

The processing pipeline is defined in [supervisor/index.ts](file:///c:/Users/nadavs.CITYSHOB/Desktop/invoice-scan/src/agents/supervisor/index.ts) and runs in the following order:

1. **`init_rules`:** Fetch client-specific dynamic rules from the database.
2. **`preprocess`:** Run Google Vision OCR. If a multi-page PDF contains multiple invoices, Claude Haiku detects split boundaries. The PDF is split, parts are uploaded, and child pipelines are triggered.
3. **`extract`:** Use Claude 3.5 Sonnet with a tool-use definition (`save_invoice_data`) to extract invoice fields and bounding box coordinates (bboxes).
4. **`validate`:** Run calculations, Luhn checksum for Israeli VAT IDs (H.P.), whitelist category checks, and database duplication checks.
5. **`save_review` / `save_success`:** Invoices currently route to `save_review` since manual review is forced (`requires_manual_review: true` in validation). The status becomes `review` and execution interrupts.
6. **`approval`:** When a human reviews the invoice, the client-side invokes `resumeApproval` to update the state graph with modified values and finishes the graph.

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
- `SUPABASE_SERVICE_ROLE_KEY`

---

## 🤖 AI Agent Protocol & Operational Rules
1. **Self-Documenting Updates:** After any code change, feature addition, or architectural refactor, the agent **MUST** update this `PROJECT_CONTEXT.md` file if there are any new directories, rules, tech stack additions, or flow modifications. Keep this document up-to-date and accurate.
2. **Auto-Git Push & Versioning:** Once a task is completed, fully verified, and the user's requirements are met, the agent **MUST** run `npm run bump-version` to bump the project patch version and update the UI version display. After bumping, the agent must commit all changes (including the version files) and push them to GitHub.
