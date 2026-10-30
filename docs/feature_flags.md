# Feature flags & accountant review loop

Migration: `supabase/migrations/20261030151000_feature_flags_approval.sql`.

## Feature flags (per office)

| Piece | File |
|---|---|
| Registry (names, Hebrew label + description), pure resolution | `src/shared/featureFlags.ts` |
| Server lookups: `isEnabled(orgId, flag)`, `isEnabledForClient`, `getOrgFlags`, `setOrgFlag`, `requireFeature` | `src/lib/featureFlags.ts` |
| Browser hook: `useFeatureFlags({ orgId? \| clientId? })`, `useFeatureFlag(flag, scope?)` | `src/components/FeatureFlags/useFeatureFlags.ts` |
| Settings page "תכונות ניסיוניות" (owners only, sidebar item for owners) | `src/app/(dashboard)/settings/experimental/page.tsx` |

**Resolution** for a flag in an office: the office's row in `org_feature_flags` (owner toggled it) → otherwise
env `FEATURE_FLAGS_DEFAULT` (comma-separated flag names, e.g. `FEATURE_FLAGS_DEFAULT=accountant_review_loop`) → otherwise
**off**. "חזרה לברירת המחדל" deletes the office row. If the table can't be read (migration not applied) the env
default applies. In local mock mode there is no office: only `FEATURE_FLAGS_DEFAULT` counts and the settings page
explains that.

**Adding a flag**: add an entry to `FEATURE_FLAGS` in `src/shared/featureFlags.ts` (no migration needed; the DB only
checks the name format). Gate UI with `useFeatureFlag(...)` and every API with
`const gate = await requireFeature(access.value.orgId, '<flag>'); if (gate) return gate;` after the access guard
(→ `404` while off, so a disabled feature looks like it doesn't exist).

**Table** `org_feature_flags (org_id, flag, enabled, updated_at, updated_by, PK(org_id, flag))`. RLS: members `select`
(`is_org_member`), owners `insert/update/delete` (`is_org_owner`, with check); nothing for anon.

**API**

| Route | Who | |
|---|---|---|
| `GET /api/feature-flags?clientId=\|orgId=` | any member | `{ orgId, flags: { <flag>: boolean } }` for the client's office / that office / the current office |
| `GET /api/org/feature-flags?orgId=` | owner | `{ orgId, flags: [{ flag, label, description, enabled, defaultEnabled, override }] }` |
| `PUT /api/org/feature-flags` `{ orgId?, flag, enabled: true\|false\|null }` | owner | same response; `null` = back to default |

## `accountant_review_loop` - "החזר ללקוח" (default OFF)

Like Morning's "return to client": the accountant sends an expense back to the client with a reason, the client is
notified, and the corrected document the client re-sends is linked to the returned one.

- **Review screen** (`/review/[id]`): "החזר ללקוח" button (statuses `review`, `approved`, `rejected`, `error`; not
  `processing` / `exported` / already `returned`) opens `ReturnToClientDialog` with the preset reasons
  **מסמך לא קריא, חסר מספר הקצאה, לא חשבונית מס, הוצאה פרטית, אחר** + free text (required for "אחר", ≤ 500 chars;
  `validateReturnReason` in `src/shared/returns.ts`, checked in the browser and again on the server).
- `POST /api/invoices/[id]/return` `{ reasonCode, note? }` (`requireInvoiceAccess` + flag) sets `status = 'returned'`,
  `return_reason_code`, `return_reason` (text sent to the client), `returned_at`, `returned_by`, then notifies the
  client. `409` if the status isn't returnable or changed concurrently.
- **Notifications** (`src/lib/returns.ts`, channel choice `selectNotificationChannels` in `src/shared/returns.ts`):
  - email to `clients.contact_email` via AWS SES (`src/lib/email.ts`, the helper `/api/lead` uses), sender
    `CLIENT_NOTIFY_EMAIL_FROM` (fallback `CONTACT_FROM_EMAIL` / `CONTACT_FROM`; must be an SES-verified identity);
  - WhatsApp to each `client_contacts` phone (max 3) via the Twilio REST API (`src/lib/whatsappSend.ts`), reusing
    `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` from ingestion; sender `TWILIO_WHATSAPP_FROM` (fallback
    `TWILIO_WHATSAPP_NUMBER`);
  - a channel that isn't configured, or a client without an email / phone, is recorded as `not_sent` with the reason;
    provider errors as `failed`. Every attempt is a row in **`client_notifications`** (`org_id, client_id, invoice_id,
    kind, channel, recipient, status, error, provider_message_id, created_by, created_at`; the "to" column is called
    `recipient` because `to` is an SQL keyword). The log is written by the server only; members can read it (RLS).
  - The message (`buildReturnMessage`) names the document (supplier · number · total), the reason, and how to re-send
    (the client's inbound email address when `INBOUND_EMAIL_DOMAIN` is set, the WhatsApp number when configured).
  - WhatsApp only delivers free-form text within 24h of the client's last message to the number; outside that window
    Twilio rejects it (logged as `failed`). For reliable delivery register an approved template in Twilio.
- **Client email**: "עדכונים ללקוח" section in the clients page "ערוצי קליטה" dialog → `GET/PUT /api/clients/[id]/contact-email`.
- **Re-sent document**: the client sends the corrected document through the normal channels (upload / email / WhatsApp).
  After extraction, the pipeline's save nodes call `linkResubmission()`: a `returned` invoice of the same client with
  the same supplier (VAT id when both have one, else folded name) and normalized invoice number gets
  `resubmitted_invoice_id = <new>`, the new invoice gets `resubmission_of = <returned>`, the duplicate flag pointing at
  the returned invoice is dropped and the warning "מסמך מתוקן לחשבונית שהוחזרה ללקוח" is added. A trigger keeps both
  links within one client.
- **Invoice table**: status filter "הוחזר ללקוח (N)" and the reason under the file name; banners on the review screen
  show the reason, the notification log and links between the returned invoice and its correction.
- **Flag off**: no button, banner, filter or email field is rendered, and `/api/invoices/[id]/return`,
  `/api/invoices/[id]/notifications`, `/api/clients/[id]/contact-email` answer `404`.

**Schema changes**: `invoices.status` accepts `'returned'` (the migration replaces an existing CHECK constraint or adds
the value to an enum, whichever the live column uses); new columns on `invoices` (above) and `clients.contact_email`.
After applying, run `npm run db:pull-types`.

No per-client secrets are stored by this feature (provider credentials stay in server env).

### Guards added in review
- An `approved` invoice that is matched to a bank statement line can't be returned (409): unmatch it in "התאמות בנק" first, so no bank line points at a returned document.
- The generic `PATCH /api/invoices/[id]` refuses `status: 'returned'` (only the flagged return route sets it, with a reason and a client notification) and ignores the review-loop audit columns (`return_reason*`, `returned_at`, `returned_by`, `resubmitted_invoice_id`, `resubmission_of`).
- Migration: only CHECK constraints on the `status` column itself are replaced (and only re-added if one existed); the partial index uses `returned_at is not null`, because a newly added enum value can't be used in the same transaction.
