# Export plugins (bookkeeping integrations)

Approved invoices are exported through **plugins**: one plugin per bookkeeping system or file format.
Each client (company served by the office) chooses which plugins it uses and stores its own credentials.

Migration: `supabase/migrations/20261030150000_export_plugins.sql`. Code: `src/integrations/`,
`src/lib/secrets.ts`, API routes under `src/app/api/integrations/` and `src/app/api/clients/[id]/integrations/`,
UI `src/app/(dashboard)/integrations` ("חיבור להנהלת חשבונות"), `src/app/(dashboard)/integration-logs`
("יומן אינטגרציות") and the "ייצוא להנהלת חשבונות" button in the review table (`IntegrationExportDialog`).

## Built-in plugins

| id        | kind | What it does |
|-----------|------|--------------|
| `movein`  | file | `movein.dat` (Windows-1255, fixed width) via the existing `MoveinExporter`. Byte-for-byte the same output as `POST /api/export`; invoices whose values don't fit the fixed-width fields fail validation (see *Move-in file format* below). |
| `excel`   | file | `.xlsx` (RTL) with invoice fields + resolved account codes (supplier / expense / VAT) and a totals row. |
| `webhook` | api  | POSTs each invoice as JSON to an https URL of the office (own middleware, Make / Zapier, an import hook). Optional Bearer token and HMAC signature. Reference implementation of an API plugin. |
| `morning` | api  | Morning / Green Invoice (חשבונית ירוקה): one expense per invoice (`POST /expenses`) + the stored PDF attached. See below. |
| `icount`  | api  | iCount API v3: one expense (`expense/create`) per invoice, **draft by default**. See [iCount](#icount) below. |
| `sumit`   | api  | SUMIT expense document (`/accounting/documents/addexpense/`) per invoice, PDF attached, **draft by default**, duplicate lookup via `documents/list`. No sandbox at SUMIT. Details, VAT / credit-note / allocation-number assumptions: `src/integrations/plugins/sumit/README.md`. |

### Morning (`src/integrations/plugins/morning/`)

- Config: `clientId` + `clientSecret` (API key from Morning, both secret), optional `defaultDocumentType`
  (`305` / `320`) and `attachPdf` (`yes` default / `no`). Sandbox and production per client.
- Hosts: API `https://sandbox.d.greeninvoice.co.il/api/v1` / `https://api.greeninvoice.co.il/api/v1`; token
  `POST https://api.sandbox.morning.dev/idp/v1/oauth/token` / `https://api.morning.co/idp/v1/oauth/token`
  (`client_credentials` -> `{ accessToken, expiresAt }`, 1 h). The token is cached in memory per client +
  environment + credentials (hash) until 60 s before expiry; a 401 drops it and repeats the call once.
- Mapping: `documentType` 330 for credit notes (negative total, or "חשבונית זיכוי" in the OCR text), else 320 when
  the OCR text says "חשבונית מס / קבלה", 305 for "חשבונית מס", otherwise the configured default. `amount` = total incl.
  VAT, `vat` = VAT part (absolute values; missing values derived), `reportingDate` = first of the invoice month,
  `supplier { name, taxId, accountingKey (only a mapped supplier code), add: true }`,
  `accountingClassification` = `{ id }` when the mapped expense account is a Morning classification UUID, else
  `{ key: <expense account code> }` (the spec documents `id` or inline details; whether `key` alone is accepted is
  unverified against the live API, so map Morning classification ids when in doubt), `allocationNumber`,
  `currency: ILS`, `remarks: invoice-scan:<invoice id>`. Missing number / date / supplier / amount / mapped category,
  a date before 2010-01-01 or a future date (Morning rejects both) block the export.
- Idempotency: before every create, `POST /expenses/search` (number + reporting-month range: Morning filters
  `fromDate` / `toDate` on `reportingDate` and accepts only `YYYY-MM-01`, so the invoice month -2 .. +6 months; up to
  3 pages) and a match on number + supplier (tax id, else name) + document family (305 / 320 alike, 330 separate),
  ignoring deleted (status 100) expenses; a match
  is adopted. `POST /expenses` is non-idempotent (no retry on 5xx / timeout; the run marks it uncertain).
- PDF: `GET /file-upload/v1/url?context=expense&data={"id":<expense>,"source":5,"state":"expense"}` -> presigned S3
  POST (`url` must be `*.amazonaws.com`, 60 s), multipart with `file` last. The file is read server-side from the
  `raw-invoices` bucket (`src/integrations/files.ts`, `ctx.files`; only the invoice's own client folder). An
  attachment failure is logged (`attach_pdf`) but never fails the export, since the expense already exists.
- Errors: Morning `errorCode` / `errorMessage` (and OAuth `error`) become `MorningApiError` with a Hebrew message
  such as "מורנינג: שגיאה ביצירת ההוצאה - פרטי הספק חסרים [קוד 3311]", stored as the export's `last_error`.

### Move-in file format

`src/lib/exporters/movein.ts` writes one 332-character line per invoice, CRLF-terminated, Windows-1255, Hebrew in
visual order. Field widths (`MOVEIN_FIELD_WIDTHS`): reference (invoice number) 9, account codes 15, VAT ids 15,
amounts 12, supplier name 50, bank details 50.

- **Identifying values are never cut.** An invoice number longer than 9 characters, an account code / VAT id longer
  than 15 or an amount wider than 12 fails validation (`validateMoveinInvoice`): `POST /api/export` answers 422
  `{ error, invalid: ["<invoice>: <Hebrew reason>"], invoiceIds }` and exports / marks nothing; the `movein` plugin
  fails those invoices with the same reasons (`validateInvoice`). Fix the value in review (e.g. shorten the
  invoice number to what the accountant books as the reference) and export again.
- **Free text is cut to its width on purpose:** supplier name and bank details keep their first 50 characters
  (cut before the visual-order reversal, so the start of the name is kept).
- Characters outside Windows-1255 become `?`; Latin-1 letters are not passed through (0xE0-0xFA are Hebrew there).
- **Download:** `POST /api/export` returns the bytes as `application/octet-stream` (`Content-Disposition:
  attachment; filename="movein.dat"`, `X-Content-Charset: windows-1255`). It must not be served as `text/*`: on
  Amplify Hosting a text body is handled as UTF-8 and every Hebrew byte became U+FFFD (QA #2). The plugin path
  returns the file base64-encoded inside JSON, which is safe for any content type.
- Ids of invoices outside the user's offices are treated exactly like unknown ids (400 "לא נמצאו חשבוניות
  מאושרות" on `/api/export`, 404 "חלק מהחשבוניות לא נמצאו" on `/api/integrations/export`), so the response never
  reveals that an id exists in another office (QA #38).

The legacy `POST /api/export` (Move-in download from the review table) keeps its behaviour otherwise. Note: the only other Excel
exporter in the codebase (`src/lib/exporters/missingInvoices.ts`) is the bank "missing invoices" sheet, which is not
an invoice export, so it stays where it is; the `excel` plugin is a new invoice workbook.

## Writing a plugin

```
src/integrations/plugins/<id>/
  index.ts    the plugin object (ApiExportPlugin or FileExportPlugin from src/integrations/types.ts)
  mapping.ts  ExportInvoice + InvoiceMapping -> the target's payload (pure, easy to test)
  client.ts   the target's API calls - ONLY through ctx.http (file plugins: the file writer)
```

Then add it to `BUILTIN_PLUGINS` in `src/integrations/registry.ts`. `createRegistry()` validates every plugin at
module load (id format, capabilities, `configFields` <-> `configSchema` keys match, password fields are secret,
required functions present), so a broken plugin fails the build / tests, not a customer export.

Contract (see `src/integrations/types.ts`):

- `id` (lowercase / digits / `-`; stored in the DB, never rename), `displayName` + `description` (Hebrew), `kind`.
- `configSchema` (zod) + `configFields` (UI + secrecy). **Every credential must be a field with `secret: true`**:
  it is then encrypted at rest, shown masked, and its key *and value* are redacted from every log line.
- `capabilities`: `attachPdf`, `allocationNumber`, `duplicateCheck`, `sandbox`. With `sandbox` the client picks
  sandbox / production; `ctx.environment` tells the plugin which base URL / credentials to use.
- `testConnection(ctx)` -> `{ ok, message }` (Hebrew message, no secrets). Used by the "בדוק חיבור" button.
- API plugins:
  - `buildPayload(ctx, invoice, mapping)` - pure; used for dry runs and by `exportInvoice`.
  - `exportInvoice(ctx, invoice, mapping)` -> `{ externalId, url? }`; throw on failure (the message is stored and
    shown, secrets scrubbed). Only https `url`s are kept.
  - `findExisting?(ctx, invoice)` - look the document up in the target (by invoice number + supplier, or by the
    idempotency key you sent). Strongly recommended: it lets an uncertain earlier attempt be resolved without
    creating a duplicate.
  - `listSuppliers?` / `listAccounts?` - for a future mapping UI.
  - `validateInvoice?(invoice, mapping)` - extra checks; returned strings block that invoice's export.
- File plugins: `buildFile(ctx, items)` -> `{ fileName, contentType, body, invoiceIds }` (no network).

`ExportInvoice` is the invoice with `validated_data ?? extracted_data` as `data`; `InvoiceMapping` holds the account
codes resolved from the client's `account_mappings` (supplier falls back to `3499` like Move-in; an unmapped
expense category blocks the export with "קטגוריה: X").

`ctx` gives the decrypted, schema-validated `config`, `environment`, `http` (below), `logger`
(`info/warn/error` = redacted JSON console lines, `record()` = a non-HTTP row in `integration_logs`),
`correlationId`, `dryRun` and `files` (`src/integrations/files.ts`: `files.load(invoice)` returns the invoice's own
file - only an object of that client in the `raw-invoices` bucket, read with the Storage API, never `file_url` as a
URL; PDF / JPEG / PNG by magic bytes, max 20 MB - for plugins with `attachPdf`; `load` throws a coded `InvoiceFileError`, `files.read(invoice)` is the same
but returns null on any failure).

## iCount

`src/integrations/plugins/icount/` (API v3, `https://api.icount.co.il/api/v3.php/<module>/<method>`, POST JSON).
No public sandbox exists, so the plugin is production-only (`capabilities.sandbox = false`) and the **"טיוטות בלבד"
toggle is ON by default** (`is_draft: true`; only an explicit "off" creates final expenses).

- **Auth**: API token (`Authorization: Bearer`, recommended) or `cid` + `user` + `pass` -> `auth/login` -> `sid` sent
  in the body. The sid is cached in memory per credentials (SHA-256 key, 20 min) and renewed once on an auth error
  (`auth_required` / `bad_auth` / ...). `pass`, `apiToken` are secret fields; `sid` is a redacted key in every log.
- **Export** per invoice: supplier via `supplier/get_list` by `vat_id` (asked as the 9-digit form, then without leading zeros; matched on the normalized digits; without a vat id
  by exact name), else `supplier/add` (`supplier_name` + `vat_id`; `duplicate_*` -> looked up again). Then
  `expense/search` (supplier + `expense_doctype` + `expense_docnum`, drafts included, results re-filtered locally):
  an existing document is adopted. Then `expense/create` with `expense_type_id`, `expense_doctype`,
  `expense_docnum` = invoice number, `adv_expense: true`, `expense_sum` = amount before VAT, `expense_manual_vat` =
  VAT (or `manual_no_vat` when VAT is explicitly 0; an invoice whose VAT is unknown is blocked, never sent as VAT-free), `invoice_date` = `vat_date`, `allocation_number`, `is_draft`, `comment`
  = `invoice-scan:<invoice id>`. `expense_already_exists` -> searched again and adopted.
- **Credit notes** (negative total): `creditDocType` (default `refund`) with absolute amounts.
- **Expense type**: `defaultExpenseTypeId`, or (toggle) the category's account code from the account mappings is the
  iCount `expense_type_id`. "בדוק חיבור" lists the expense types and checks the doc types against `expense/doctypes`.
- **Errors**: `{ status: false, reason, error_description }` (usually HTTP 200) become `IcountApiError` with the
  reason in the message; such a failure is certain (not "uncertain"). Reads are retried on 5xx / timeouts, writes
  (`supplier/add`, `expense/create`) only on 429 / not-sent errors.
- Not yet: attaching the PDF (`scan` upload; needs a binary file loader in the plugin context).

## Export flow

`POST /api/integrations/export` `{ invoiceIds, pluginId, dryRun?, force? }` (max 200 invoices, one client):

1. Route guards: session, every invoice exists and belongs to a client of the user's office, one client only.
2. The client's integration is loaded and decrypted (file plugins without config work without a stored row; API
   plugins need an enabled row).
3. Per invoice, the idempotency decision (`src/integrations/idempotency.ts`, unit-tested) on `invoice_exports`
   (unique per invoice + plugin):
   - `success` -> skipped "already exported" (also with `force`: delete it in the target first);
   - `pending` younger than 10 min -> skipped "in progress";
   - `pending` older (the earlier run died mid-request) -> `findExisting` if the plugin has it, else **blocked**
     until the user re-runs with `force` ("ייצוא חוזר בכל זאת") after checking the target;
   - `failed` with `outcome_uncertain` (the failed attempt was a write that timed out, lost the connection after
     sending, or got a 5xx, so the document may exist anyway) -> same as a stale `pending`: `findExisting`, else
     **blocked** until `force`;
   - `failed` (certain, e.g. 4xx / validation) / `skipped` / none -> export (after `findExisting` when available; a
     found document is *adopted*);
   - invoice not `approved` / `exported` -> skipped (a `skipped` row is recorded).
4. Invoices are claimed with an optimistic update (`status`, `attempts` must match) before any call, so two
   concurrent runs never send the same invoice.
5. The plugin is called; the row ends as `success` (external id / url, `exported_at`) or `failed`
   (`last_error`, `outcome_uncertain`). The runner tracks every write call of the invoice through `ctx.http` to set
   `outcome_uncertain`. If the document was created but recording `success` fails, the row is left `pending` (never
   `failed`), so a later run blocks / checks instead of creating a duplicate. Successful invoices still in
   `approved` become `exported`.
6. **Dry run** builds the payloads (redacted) or the file without any HTTP call or DB write.

Response: `{ correlationId, pluginId, dryRun, environment, results[], summary, file? }` (file = base64 for file
plugins). `GET /api/integrations/exports?clientId=&pluginId=` returns the per-invoice status rows.

## HTTP client and logging (`src/integrations/http.ts`)

Every plugin must call external systems through `ctx.http.request({ operation, method, url, headers, json | body,
timeoutMs?, idempotent? })`; never `fetch` directly. It provides:

- **Timeout** per attempt (default 15 s, AbortController).
- **Retries** (`src/integrations/retry.ts`): up to 4 attempts on 429 / 500 / 502 / 503 / 504 / network errors /
  timeouts, exponential backoff with full jitter (500 ms base, 8 s cap). `Retry-After` (seconds or HTTP date) is
  honoured; if it asks for more than 30 s we stop and report instead. **Non-idempotent requests** (POST / PATCH
  unless `idempotent: true`) are retried only on 429 and connection errors where nothing was sent, because a
  5xx / timeout may already have created the document. Mark a POST `idempotent: true` only when it carries an
  idempotency key the target is **known** to honour. The webhook plugin sends `Idempotency-Key` but does not rely on
  it (generic receivers such as Make / Zapier ignore it), so its export POST is non-idempotent.
- **Outbound URL guard**: https only, no credentials in the URL, no localhost / `.local` / `.internal` /
  single-label hosts / private, loopback, link-local (cloud metadata), CGNAT, IPv4-mapped / NAT64 / 6to4 IP literals.
  Host names are also resolved (`dns.lookup`, all addresses) before the call and refused if any address is
  private. There is no connection pinning, so a DNS-rebinding host with a tiny TTL is not fully excluded.
  Redirects are not followed (`redirect: 'manual'`).
- **Redaction** (`src/integrations/redact.ts`, unit-tested), applied before anything is stored or printed:
  auth headers (`Authorization`, `Cookie`, `X-Api-Key`, signatures...), secret-looking keys at any depth incl.
  arrays (`password`, `token`, `api_key`, `client_secret`, `*Secret`, `*Token`...), the plugin's secret config keys,
  any occurrence of a secret config **value** (also URL-encoded) in bodies, URLs and error messages, URL userinfo and
  secret-looking query parameters.
- **Logging**: one `integration_logs` row per attempt (`operation`, method, redacted URL, redacted request body,
  status, response body - both truncated to 20 KB, duration, attempt, outcome `ok` / `retry` / `error`, error code /
  message, `invoice_id`, `correlation_id`) and one structured JSON console line (`event: "integration_http"`, no
  bodies) for CloudWatch. A failing log insert never fails the call.
- **Correlation id**: one UUID per export run / connection test, on every row and console line (also sent to the
  webhook as `X-Correlation-Id`). The export dialog and the test result link to the log filtered by it.

UI: **יומן אינטגרציות** (`/integration-logs?clientId=...`): newest first, filters (system, outcome, invoice id, run),
paging, and a drawer with the redacted request / response bodies (`GET /api/integrations/logs`,
`GET /api/integrations/logs/[id]`).

### Retention

Logs hold invoice data (amounts, supplier names), so keep them only as long as needed for support: **90 days by
default**. The migration adds `public.purge_integration_logs(days)` (service role only). Schedule it daily, e.g. with
pg_cron in the Supabase SQL editor:

```sql
select cron.schedule('purge-integration-logs', '15 3 * * *', $$select public.purge_integration_logs(90)$$);
```

`invoice_exports` is the durable export record and is not purged.

## Secrets (`src/lib/secrets.ts`)

- Per-client plugin config is stored in `client_integrations.config_encrypted` as
  `v1:<iv>:<tag>:<ciphertext>` (base64), **AES-256-GCM**, random 12-byte IV, 16-byte tag, AAD
  `client_integrations:<client_id>:<plugin_id>` (a ciphertext copied to another row does not decrypt).
- Key: env **`INTEGRATIONS_ENCRYPTION_KEY`** = 32 random bytes, base64. Generate with
  `openssl rand -base64 32` (or `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`)
  and set it in Amplify (server env, never `NEXT_PUBLIC_*`). Without it, configs with values cannot be saved (the
  UI shows a warning) and API plugins cannot run; file plugins still work.
- Decryption happens only server-side, right before building the plugin context. The browser only ever gets
  `config_masked` (secret values as `••••` + last 4 characters of values with 12+ characters). Saving a form with a
  secret left empty (or still showing the mask) keeps the stored value; "נקה" sends `null` to remove it.
- **Endpoint changes require re-entering the secrets**: if a `url` field changes while a stored secret would be kept
  (sent empty / masked), save and "בדוק חיבור" are refused (422). Otherwise any office member could point the stored
  token, which they cannot see, at their own server.
- `authenticated` cannot select `config_encrypted` (column-level grant) and has no write access to the three
  tables; all writes go through the guarded API routes (service role).
- **Key rotation**: there is one key version (`v1`). To rotate, deploy with the new key and have each client
  re-enter its credentials (a config that can no longer be decrypted is treated as empty and the user is asked to
  re-enter it), or add a `v2` prefix with dual-key decryption before switching.

## Tables

- `client_integrations` (client_id, plugin_id, enabled, environment `sandbox|production`, config_encrypted,
  config_masked jsonb, created_at, updated_at; unique (client_id, plugin_id)).
- `invoice_exports` (invoice_id, client_id, plugin_id, status `pending|success|failed|skipped`, external_id,
  external_url, attempts, last_error, outcome_uncertain, correlation_id, exported_at; unique (invoice_id, plugin_id)). A trigger
  enforces that client_id is the invoice's client.
- `integration_logs` (org_id, client_id, plugin_id, invoice_id, correlation_id, operation, http_method, url,
  request_body, response_status, response_body, duration_ms, attempt, outcome `ok|error|retry`, error_code,
  error_message, created_at; index (client_id, created_at desc), plus correlation_id and invoice_id).

RLS: enabled on all three; `anon` gets nothing; `authenticated` policies are scoped like the other tenant tables
(`client_id in (select accessible_client_ids())`, with check), and grants make them read-only (minus
`config_encrypted`).

## API

```http
GET    /api/integrations/plugins                         # plugin metadata (no schema / functions)
GET    /api/clients/:id/integrations                     # plugins + the client's masked settings + encryptionConfigured
PUT    /api/clients/:id/integrations/:pluginId           # { enabled?, environment?, config? } -> masked view
DELETE /api/clients/:id/integrations/:pluginId
POST   /api/clients/:id/integrations/:pluginId/test      # { environment?, config? } (unsaved values allowed) -> { ok, message, correlationId }
POST   /api/integrations/export                          # { invoiceIds, pluginId, dryRun?, force? }
GET    /api/integrations/exports?clientId=&pluginId=
GET    /api/integrations/logs?clientId=&pluginId=&outcome=&invoiceId=&correlationId=&limit=&before=
GET    /api/integrations/logs/:id
```

Every route uses the guards from `src/lib/auth.ts` (session + the client / invoice / log row belongs to the user's
office) before touching the service-role client.

## Tests

Pure-logic checks (encryption round-trip + tamper detection, redaction, retry / backoff, idempotency decision,
config merge / masking, registry validation, the export runner with fake store / fetch incl. Move-in byte
equality) are run as scratch scripts with `npx tsx` (not committed; the repo has no test runner).
