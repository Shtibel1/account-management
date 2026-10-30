# SUMIT plugin (`sumit`)

Exports each approved invoice to SUMIT (app.sumit.co.il) as an **expense document**.
Spec: <https://app.sumit.co.il/swagger/v1/swagger.json> (OpenAPI 3.1, server `https://api.sumit.co.il`).
Written and contract-tested against the spec only: **no real SUMIT account / credentials were used**.
Before enabling it for a customer, do one manual export in a SUMIT company with `documentMode = draft` and
check the points marked *unverified* below.

## Files

- `mapping.ts` - pure: config defaults, invoice -> `addexpense` body, duplicate matching.
- `client.ts` - SUMIT calls through `ctx.http` + the response envelope parser.
- `index.ts` - the plugin object (registered in `src/integrations/registry.ts`).

## Calls

All SUMIT endpoints are `POST` with a JSON body and answer HTTP 200 with
`{ Status, UserErrorMessage, TechnicalErrorDetails, Data }` (`Status` 0 Success, 1 BusinessError, 2 TechnicalError;
the parser accepts numbers or names, and a `text/plain` body that holds JSON).

| Operation (`integration_logs.operation`) | Endpoint | Retried on 5xx / timeout |
|---|---|---|
| `test_connection` | `/accounting/general/getvatrate/` (read-only: checks the credentials) | yes (idempotent) |
| `find_existing` | `/accounting/documents/list/` | yes (idempotent) |
| `export_invoice` | `/accounting/documents/addexpense/` | **no** (only 429 / connection refused) |

- **Auth**: `Credentials { CompanyID (int), APIKey }` in every body. SUMIT has no token / session, so there is
  nothing to obtain or cache, and no `Authorization` header. `apiKey` is a secret config field (encrypted at rest,
  masked in the UI, key and value redacted from logs); `companyId` is not secret.
- Errors: `BusinessError` -> `SUMIT דחה את הבקשה: <UserErrorMessage>` (certain failure). `TechnicalError` ->
  `שגיאה טכנית ב-SUMIT` (the `TechnicalErrorDetails` stay in the redacted response log only). A 5xx / timeout on
  `addexpense` is recorded as *uncertain* by the runner, so the next run looks the document up first.
- No sandbox at SUMIT: `capabilities.sandbox = false`. Safety instead: **`documentMode` defaults to `draft`**
  (`IsDraft: true`), so nothing reaches the books until someone finalizes it in SUMIT.

## Mapping (`addexpense`)

| SUMIT | From |
|---|---|
| `Supplier.Name` | `supplier_name` |
| `Supplier.CompanyNumber` | `supplier_vat_id`, digits only |
| `Supplier.SearchMode` | `4` CompanyNumber when there is a VAT id, else `3` Name (SUMIT creates the supplier when not found - *unverified*) |
| `Supplier.NoVAT` | `true` only when the invoice VAT is 0 (exempt dealer); otherwise not sent |
| `ExpenseNumber` | `invoice_number` |
| `Date` | `invoice_date` (`YYYY-MM-DD`) |
| `Lines[0].Item` | expense account code from the client's category mapping (or `defaultItem`), matched by `itemMatch`: `name` (default, `Name` + SearchMode 3), `externalId` (`ExternalIdentifier` + 2) or `id` (numeric `ID`) |
| `Lines[0].Amount` | see VAT below |
| `Description` | `מספר הקצאה: <allocation_number> \| [invoice-scan:<invoice id>]` |
| `IsDraft` | `documentMode` (default draft) |
| `ExpenseFile` / `ExpenseFilename` | the invoice's own file (base64; `ExpenseFilename` gets the extension of the detected type; in `integration_logs` the base64 is summarized as `[base64 N chars]`), loaded via `ctx.files` (only the client's own `raw-invoices` object, PDF / JPEG / PNG by magic bytes, max 20 MB). `attachFile = no` sends neither |

One line per invoice: our line items have no per-line expense category, and one line keeps SUMIT's total equal
to the invoice total.

### VAT assumption

`addexpense` has no VAT amount, VAT rate or "VAT included" field: each line has one `Amount` and SUMIT derives the
VAT itself (from its VAT rate and the supplier's `NoVAT`). We therefore send:

- `amountMode = gross` (**default**): the invoice total **including VAT** (`total_amount`, or before + VAT).
  This matches the SUMIT expense screen, where the amount is entered including VAT - *unverified via the API*.
- `amountMode = net`: the amount **before VAT** (`amount_before_vat`, or total - VAT), for companies where SUMIT
  treats expense amounts as net.

A missing value is derived only from the other two (total = before + VAT, before = total - VAT). An amount that
cannot be derived blocks the export (e.g. `net` mode with only the total known) instead of guessing, and an
**unknown** VAT is never treated as zero VAT: `Supplier.NoVAT` is sent only when the VAT is known to be 0.

Our extracted `vat_amount` is not sent. If an invoice's VAT is not the standard rate (partial deduction, e.g.
vehicles), the VAT SUMIT computes will differ from the document: check / fix such expenses in SUMIT.

### Credit notes

Recognised by negative amounts (as in the validation agent). `addexpense` has no document type, so a credit note
is sent with a **negative** `Amount`; whether SUMIT books it as a credit expense document (types 19-21) is
*unverified*.

### Allocation number (מספר הקצאה)

`addexpense` has no allocation number field (the list response has `AssignmentNumber`, but the request cannot set
it), so it is written into `Description`. `capabilities.allocationNumber = true` means "sent", not "in its own field".

## Idempotency (`findExisting`)

Runs before every export (the runner always checks first when a plugin has `findExisting`) and after an uncertain
earlier attempt. `documents/list` with `DocumentTypes [15, 16, 17, 19, 20, 21]` (expense invoice / receipt /
invoice-receipt and their credits), `DateFrom` / `DateTo` = invoice date +- 1 day, `IncludeDrafts: true` (we create
drafts), `PageSize 1000`, up to 5 pages. A document is ours when:

1. its `Description` contains our marker `[invoice-scan:<invoice id>]`, or
2. `ExternalReference` (the expense invoice number) equals `invoice_number` (trimmed, case / leading zeros
   ignored) **and** either the supplier name (`CustomerName`, punctuation / בע"מ ignored) or the amount
   (`DocumentValue` vs gross or net, absolute) matches.

The found `DocumentID` is adopted. A failed lookup (error envelope, more than 5 pages) throws, so it is never
mistaken for "not found". `DocumentDownloadURL` is not stored (SUMIT serves the original only on the first visit).

## Config

| key | type | default |
|---|---|---|
| `companyId` | text, required, digits | - |
| `apiKey` | password, secret, required | - |
| `documentMode` | `draft` / `final` | `draft` |
| `amountMode` | `gross` / `net` | `gross` |
| `itemMatch` | `name` / `externalId` / `id` | `name` |
| `defaultItem` | text | - (invoices without a category are blocked) |
| `attachFile` | `yes` / `no` | `yes` |

## Tests

Contract tests (fake `fetch`, exact URL / method / headers / body, envelope parsing, retries, lookup paths, the
export runner end to end) are scratch scripts run with `npx tsx`, not committed (the repo has no test runner).
