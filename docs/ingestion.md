# Ingestion Channels (Upload · Email · WhatsApp)

Invoices can reach the pipeline through three channels. All of them end in the same server-side
function, `ingestDocument()` in [`src/lib/ingest.ts`](../src/lib/ingest.ts), which:

1. stores the file in the `raw-invoices` bucket (`<clientId>/<timestamp>_<safe name>`),
2. creates the `invoices` row (`status = 'processing'`, `source = 'upload' | 'email' | 'whatsapp'`),
3. queues the pipeline (see **Processing queue** below), so webhooks answer immediately.

The browser upload goes signed upload URL → `/api/invoices/upload`, which registers each file with
`registerStoredDocument()` from the same module and **queues it on the server** (`queued: true` per result).
The browser calls `/api/invoices/[id]/process` only for a row the server could not queue (it is
idempotent for an already-queued run); a row that stays unqueued is queued by the worker's sweep.

Every channel is **off until its environment variables are set** - the endpoints answer `503` otherwise.
No provider is configured in this repository.

## Upload checks

The browser uploads straight to Storage, so the server checks twice: `/api/invoices/upload-url` refuses
unsupported names / declared types and sizes over 20 MB (`checkUploadDeclaration`), and
`registerStoredDocument()` reads the stored bytes and refuses empty files, files over 20 MB and anything that
is not a real PDF / JPG / PNG / WEBP by magic bytes (`checkStoredBytes`, [`src/shared/uploadValidation.ts`](../src/shared/uploadValidation.ts)),
including a PDF header followed by garbage (no indirect object near the start: "damaged, re-export or re-scan").
A PDF that passes but whose page tree pdf-lib can't read (`getPageCount()` throws) fails processing at once with the
same message, as a permanent error (no retries; QA round 4).
A refused file gets no invoice row, its object is removed, and the upload screen shows the Hebrew reason per file.
The migration `20261030161000_qa_pipeline.sql` also sets the `raw-invoices` bucket limits (20 MB, those four types).

## Processing queue

Amplify cuts every HTTP response at ~28 s, so no request runs the whole pipeline
([`src/lib/processingQueue.ts`](../src/lib/processingQueue.ts)). And **nothing runs after a response**:
Amplify SSR compute is a Lambda without `waitUntil`, so work left in `next/server` `after()` is frozen until
a later request thaws the instance (QA round 3: leases lapsed, sockets broke, uploads took 20-50 minutes or
failed). All processing therefore runs inside requests, in steps that end before the request's deadline;
there is no `after()` in `src`.

- Every entry point only **enqueues** (status guard, new `processing_run_id`, `processing_started_at`,
  `processing_attempts`, a `processing_jobs` row): `/api/invoices/upload`, the email / WhatsApp webhooks,
  `/retry`, the manual split and `POST /api/invoices/[id]/process` (`202`). Approved invoices need an
  explicit reopen first; exported / rejected / returned invoices get `409`. For a `processing` invoice whose
  run is already queued and live, `/process` answers `202 { alreadyQueued: true }` (not a `409` toast).
- The work runs in short resumable **ticks**: OCR of a few pages per tick (only those pages are sent to
  Vision), then boundary detection, then **extraction in parts**: one LLM call per tick over at most 3 pages
  (a file that looks like several documents is extracted from its first document only - it can't be
  approved before it is split), then validation + save (no LLM). Every step's result is stored in
  `processing_jobs` (`extract_state`, migration `20261030180000_qa2_pipeline2.sql`) before the next one
  starts, so a killed tick re-pays only for its own call. The math retry is a step of its own.
- Every tick has a **deadline** (23 s for `/process/tick`, the worker's budget for the worker) and starts a
  step only if it fits (18 s left for an LLM step, so its call gets a full window of 15.5-20 s; 7 s for OCR;
  5 s for validation + save). OCR rounds are budgeted, file downloads, Vision, extraction and
  boundary-detection calls get time limits that end before the deadline (no SDK retries, no 16k-token
  "large retry"). Extraction calls are **streamed**: a call still writing at its limit is cut there and keeps
  the tool input written so far (the value being written is dropped). A part cut that way (or at
  `max_tokens`) with a full window is split in two; a one-page part is tried once more, then keeps its
  partial result (validation flags what is missing). A call cut only because it started late is retried as a
  transient failure, not split. Each call's duration is logged (`[Queue] Extraction of pages ...: N ms`).
- Boundary detection and the math re-read are optional: transient failures are retried twice, then the run
  goes on without them (no split suggestion - the reviewer is warned - / the first-pass result). A re-read
  that is cut keeps the first-pass result.
- A tick holds the job by a **45 s lease** (renewed by a heartbeat while the step runs). A lease that ran
  out without being released means the tick was interrupted: the next tick redoes only that step.
- **Transient vs real errors**: network drops (`fetch failed`, `Connection error.`, `ECONNRESET`, socket hang
  up...), timeouts, 429 / 5xx of Anthropic / Google / Supabase and interrupted ticks count against
  `processing_jobs.transient_attempts` (6 in a row, backoff 5 s, 10 s, 20 s ... in `retry_at`); real errors
  against `stage_attempts` (3); a bad file fails at once. Progress resets both. A failed run gets a Hebrew
  `error_message` (connection problems have their own) and the technical cause in
  `invoices.processing_error_detail` (migration `20261030191000_qa3_processing_error_detail.sql`; until it is
  applied, transient failures count as real ones).
- `POST /api/invoices/[id]/process/tick` runs one step inside the request and answers by 23 s (at the
  latest 26 s, before Amplify's bare 504).
- Ticks are driven by the **scheduled worker** `GET|POST /api/invoices/worker` and by the review screens
  (`/process/tick` every few seconds while an invoice shows as processing). The worker does its work
  **inside the request** and answers `200 { stuck, enqueued, driven: [{ id, state }], due, soon, next_due_in_ms, ms, overran? }` within
  `PROCESSING_WORKER_BUDGET_MS` (default 23 s, at most 24 s; at the latest budget + 3 s, listing steps that
  overran in `overran`): the sweep beside up to `PROCESSING_WORKER_MAX_JOBS` (default 6) due jobs in
  parallel, a freed slot taking the next due job while a step still fits. Call it every minute from an AWS Lambda (timeout 60 s) that calls again while
  `due > 0`; back-to-back and concurrent calls are safe (leases). **Re-call contract** (QA round 4): `due` = jobs
  a tick can take now; `soon` = jobs not due yet that become due within 15 s (a short transient backoff, a lapsing
  lease); `next_due_in_ms` = wait until the next of them is due (looking 20 s ahead, else `null`). Within its 60 s
  window the Lambda calls again at once while `due > 0`, and while `due == 0 && soon > 0` it sleeps
  `next_due_in_ms` (if that still leaves room for a call) and calls again; otherwise it stops until the next
  minute. The worker itself also waits for a job that becomes due before its budget ends (at most 3 times a pass),
  so a multi-part extract in a 5 s backoff no longer advances one part per minute. Sizing: see
  [`src/lib/processingWorker.ts`](../src/lib/processingWorker.ts) - 6 concurrent uploads (22- / 25-page PDFs
  included) each get an LLM step (or OCR rounds) per call, ~2 calls a minute.
  Auth: `PROCESSING_WORKER_SECRET` as `X-Ingest-Secret` / `X-Worker-Secret` / `X-Api-Key`,
  `Authorization: Bearer`, or Basic (secret as password); surrounding spaces / quotes in the configured value
  are ignored; 503 when unset. Schedule it every minute, e.g. with EventBridge Scheduler (API destination).
- A queued job whose lease is free is **resumed**, however long nobody drove it. A `processing` row that
  was never queued (`processing_attempts` 0: an upload whose enqueue didn't happen, rows from before the
  queue) is **queued** by the sweep / a tick once it is a minute old, not failed. A run that was queued but whose job row
  vanished before any step ran (still `queued`) is queued again after the same minute, at most twice in a row
  (`processing_progress.requeues`), then fails with "the queued task was lost, retry" (QA round 4). Stuck runs become `error`
  with a Hebrew reason: queued rows whose job is gone and that made no progress for 10 minutes (the clock
  starts at the latest of enqueue / job activity / row update), or runs older than 45 minutes (only these suggest splitting the file, and only for 10+ pages); the user can
  retry ("עבד מחדש" on the review screen).
- Concurrent `/process` calls start exactly one run: the claim is conditioned on the run token read, and a
  run claimed less than a minute ago counts as live even before its job row exists (the others get `409`).
  The split route queues part 1 under its own claim token (`claimToken`), which is not a competing run.
- Every pipeline write is conditioned on `processing_run_id`, so a superseded run (re-process, manual split,
  sweeper) can't overwrite the row. The UI shows `processing_stage` / `processing_progress`; while an invoice
  is processing the review form is read-only and reject / split are disabled.
- A corrected document for an invoice returned to the client is linked in the same write that ends its
  run (`resubmission_of`, the return warning, the duplicate flag dismissed), never a moment later.
- Manual split (`/api/invoices/[id]/split`): only from `review` / `error`, claimed atomically, parts keep
  `original_file_url` / `original_file_hash` / `split_parent_id` / page range, part `file_hash` =
  hash(source hash + page range), and the parts are queued on the server.

| Variable | Description |
|----------|-------------|
| `PROCESSING_WORKER_SECRET` | Secret of the scheduled worker (`openssl rand -hex 32`). Without it the worker answers 503 and runs move only while a review screen is open |
| `PROCESSING_WORKER_BUDGET_MS` | Optional. Work time of one worker call (default 20000, 5000-24000) |
| `PROCESSING_WORKER_MAX_JOBS` | Optional. Jobs one worker call drives in parallel (default 6, 1-12) |

---

## Database

Migration: [`supabase/migrations/20261030135000_ingestion_channels.sql`](../supabase/migrations/20261030135000_ingestion_channels.sql)

| Object | Purpose |
|---|---|
| `invoices.source` | `'upload'` (default) / `'email'` / `'whatsapp'` |
| `invoices.source_sender` | Sender email address or E.164 phone |
| `invoices.source_ref` | Provider message id + attachment index (`email:<Message-ID>#0`, `whatsapp:<MessageSid>#1`); unique, used to ignore webhook retries |
| `clients.inbound_alias` | Unique, random (`inv-` + 12 hex chars), generated by a column default and back-filled for existing clients |
| `client_contacts` | `(client_id, phone, name)` - phones (E.164, globally unique) allowed to send documents over WhatsApp |

Until the migration is applied the app keeps working: uploads are unaffected, invoices are inserted
without the source columns, and the email / WhatsApp endpoints simply find no client. With the local
mock DB, aliases are generated on first load of the clients page.

After applying it, run `npm run db:pull-types` to refresh `src/shared/supabase-types.ts`.

---

## Clients page

Each client card shows its inbound address (`<inbound_alias>@INBOUND_EMAIL_DOMAIN`, with a copy button)
and the number of WhatsApp phones. **"ערוצי קליטה"** opens a dialog to add / remove phones.
Phones are normalized to E.164 (`050-123-4567` → `+972501234567`). A phone can belong to one client only.

API used by the page:

| Route | |
|---|---|
| `GET /api/clients/channels` | Aliases + contacts for all clients, and which channels are configured (booleans only) |
| `POST /api/clients/[id]/contacts` | `{ phone, name? }` → 201 / 400 invalid / 404 client / 409 phone already used |
| `DELETE /api/clients/[id]/contacts/[contactId]` | Remove a phone |

---

## Email - `POST /api/ingest/email`

### Environment

| Variable | |
|---|---|
| `INGEST_EMAIL_SECRET` | **Required.** Shared secret; long random string (`openssl rand -hex 32`). Endpoint returns 503 without it |
| `INBOUND_EMAIL_DOMAIN` | Domain the aliases live on, e.g. `in.example.co.il`. Shown on the clients page; when set, only recipients on this domain are matched |

### Authentication

Any one of (compared in constant time):

- `X-Ingest-Secret: <secret>`
- `Authorization: Bearer <secret>`
- `Authorization: Basic base64(<anything>:<secret>)` - for providers that only support credentials in the webhook URL

### Body (provider-agnostic JSON)

```json
{
  "to": "Office <inv-3f9a1b2c7d4e@in.example.co.il>",
  "cc": ["optional@other.com"],
  "from": "supplier@example.com",
  "subject": "חשבונית 1234",
  "messageId": "<CAF...@mail.gmail.com>",
  "attachments": [
    { "filename": "invoice.pdf", "contentType": "application/pdf", "contentBase64": "JVBERi0xLjQK..." }
  ]
}
```

`to` / `cc` may be a string (comma-separated, display names allowed) or an array. `messageId` is optional
but recommended - it makes provider retries idempotent. Postmark's native inbound JSON is accepted as-is
(see below).

### Rules

- Client = first recipient whose local part (ignoring any `+tag`) matches a `clients.inbound_alias`.
- Each attachment is filtered by declared type / extension (PDF, JPG, PNG), then verified by magic bytes.
  Everything else (`.p7s`, `.ics`, HTML, ZIP...) is skipped.
- Images under 15 KB are skipped (signature logos, tracking pixels).
- Limits: 20 MB per document, 10 documents per email, 50 MB request body (413 above; fits Postmark's 35 MB message limit after base64).
- Responses: `401` bad secret · `400` malformed body · `200 {status:'unknown_recipient'}` (no retry) ·
  `200 {status:'ok'|'no_documents', ingested, attachments:[...]}` · `500` only when every document failed
  (so the provider retries; already-ingested attachments are skipped on retry via `source_ref`).

### Option A - Postmark inbound (simplest)

1. Postmark → Servers → *Inbound* stream. Point your domain's MX at Postmark
   (`MX 10 inbound.postmarkapp.com` on `in.example.co.il`) and set it as the inbound domain.
2. Webhook URL: `https://postmark:<INGEST_EMAIL_SECRET>@<app-host>/api/ingest/email`
   (Postmark sends the credentials as HTTP Basic auth).
3. Enable *Include raw email content* = off (not needed). Postmark posts `ToFull`, `OriginalRecipient`,
   `MessageID` and `Attachments[{Name, ContentType, Content}]`, which the route understands natively.
4. Postmark's inbound attachment limit is 35 MB per message.

### Option B - AWS SES inbound

SES can't POST JSON to a URL directly, so add a small forwarder:

1. Verify the domain in SES (region with email receiving, e.g. `eu-west-1`) and add
   `MX 10 inbound-smtp.<region>.amazonaws.com` for `in.example.co.il`.
2. Receipt rule set → rule for `in.example.co.il` → action *S3* (store raw MIME in a bucket) →
   action *Lambda* (invoke asynchronously).
3. The Lambda reads the object, parses it (e.g. `mailparser`'s `simpleParser`) and posts:

```js
// Node 20 Lambda (sketch)
const parsed = await simpleParser(rawMimeFromS3);
await fetch(process.env.INGEST_URL, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Ingest-Secret': process.env.INGEST_EMAIL_SECRET },
  body: JSON.stringify({
    to: event.Records[0].ses.receipt.recipients,   // envelope recipients (handles BCC)
    from: parsed.from?.value?.[0]?.address,
    subject: parsed.subject,
    messageId: parsed.messageId,
    attachments: parsed.attachments.map((a) => ({
      filename: a.filename ?? 'attachment',
      contentType: a.contentType,
      contentBase64: a.content.toString('base64'),
    })),
  }),
});
```

   Keep the secret in Lambda env / Secrets Manager. Let the Lambda throw on a 5xx so SES's async retry kicks in.
4. Optionally add an S3 lifecycle rule to delete raw MIME after N days.

### Testing locally

```bash
curl -X POST http://localhost:3001/api/ingest/email \
  -H "X-Ingest-Secret: $INGEST_EMAIL_SECRET" -H "Content-Type: application/json" \
  -d "{\"to\":\"<alias>@$INBOUND_EMAIL_DOMAIN\",\"from\":\"me@test\",\"attachments\":[{\"filename\":\"a.pdf\",\"contentType\":\"application/pdf\",\"contentBase64\":\"$(base64 -w0 a.pdf)\"}]}"
```

---

## WhatsApp - `POST /api/ingest/whatsapp` (Twilio)

### Environment

| Variable | |
|---|---|
| `TWILIO_ACCOUNT_SID` | **Required.** Used for media download (Basic auth) and to reject other accounts' webhooks |
| `TWILIO_AUTH_TOKEN` | **Required.** Validates `X-Twilio-Signature` and authenticates media download. 503 without it |
| `TWILIO_WEBHOOK_URL` | Recommended in production: the exact URL configured in Twilio (e.g. `https://app.example.co.il/api/ingest/whatsapp`). Twilio signs this URL; behind CloudFront / Amplify the URL the server sees can differ. Without it the URL is rebuilt from `X-Forwarded-Proto` / `X-Forwarded-Host` |
| `TWILIO_WHATSAPP_NUMBER` | Optional, display only - shown in the clients dialog (e.g. `+972 3-555-0000`) |

No `twilio` npm package is used; the signature check is implemented with `node:crypto`
(`computeTwilioSignature` in [`src/lib/ingestHelpers.ts`](../src/lib/ingestHelpers.ts)):
HMAC-SHA1(auth token, URL + each POST param name+value sorted by name), base64, constant-time compare.

### Flow

1. Verify signature → `403` if missing / invalid; `403` if `AccountSid` isn't ours.
2. `From` (`whatsapp:+972501234567`) → normalized → `client_contacts.phone` → client.
   Unknown sender → TwiML reply "המספר שלך אינו מקושר ללקוח במערכת...".
3. `MediaUrl0..N` (max 10) are downloaded in parallel with Basic auth (only from `https://*.twilio.com`,
   10 s timeout each, 20 MB cap), type verified by magic bytes, then ingested as
   `whatsapp_<date>_<n>.<ext>`.
4. TwiML reply in Hebrew: received N documents / unsupported type / failed / no attachment.

`MessageSid` is stored in `source_ref`, so a re-delivered webhook doesn't create duplicates.

### Setup

1. Twilio Console → Messaging → *Senders* → WhatsApp sender (or the WhatsApp Sandbox for testing).
2. *When a message comes in*: `POST https://<app-host>/api/ingest/whatsapp`. Use the same value for `TWILIO_WEBHOOK_URL`.
3. Set `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` in the hosting environment (Amplify → Environment variables).
4. Add the client's phones on the clients page (ערוצי קליטה).
5. Sandbox test: join the sandbox from the phone, send a photo of an invoice, expect the Hebrew confirmation
   and a new invoice in *בדיקה ואישור*.

Note: Media URLs in Twilio stay accessible until deleted; consider a periodic job that deletes processed
media via the Twilio API if retention matters.

---

## Security notes

- Endpoints fail closed: missing env → 503, bad secret/signature → 401/403.
- Aliases are random (48 bits) so an outsider can't guess a client's address; anyone who knows it can
  still send documents to that client (same model as Hubdoc / Receiptor). Rotate by clearing
  `inbound_alias` and letting the app generate a new one (or `update clients set inbound_alias = default`).
- Media is fetched only from Twilio hosts over HTTPS; credentials are dropped on the cross-origin redirect
  to Twilio's CDN.
- The `/api/clients/*` management routes follow the app's current (unauthenticated) API model - add auth
  together with the rest of the dashboard API.
