---
name: supabase-data
description: Data layer - Supabase tables (clients, invoices, account_mappings), the raw-invoices storage bucket, which Supabase client to use where, the local JSON mock DB used when env vars are missing, invoice status lifecycle, and how to change the schema and regenerate types. Use when reading/writing the DB, adding columns, touching src/lib/supabase.ts or src/utils/supabase/, or running the app without credentials.
---

# Supabase & data

Last verified against code: 2026-10-29

## Tables (as used in code)

| Table | Key columns |
|---|---|
| `clients` | `id`, `name`, `vat_account`, `created_at`, `rules` (JSONB, partial `TenantRules`) |
| `invoices` | `id`, `client_id`, `file_url` (signed URL), `file_name`, `status`, `extracted_data` / `validated_data` (JSONB `ExtractedData`), `ai_confidence`, `error_message`, `exported_at`, `created_at`, `updated_at` |
| `account_mappings` | `id`, `client_id`, `mapping_type` (`supplier` or `category`), `key` (supplier name / category text), `account_code`, `supplier_number`, `vat_id`, `expense_category` |

Storage bucket: **`raw-invoices`**, path `<clientId>/<timestamp>_<sanitized name>`. Files are reached through **1-year signed URLs** stored in `invoices.file_url`.

Status lifecycle: `processing → review → approved → exported`, plus `error`. `rejected` exists in `InvoiceStatus` but not in `InvoiceSchema`.

There is no migrations folder. The schema lives only in the Supabase project (`kpapnvjncwkoeqpfscwr`, see `package.json`).

## Which client

| Where | Use |
|---|---|
| API routes, agents (server) | `supabase` from `@/lib/supabase`. It uses the service-role key and **bypasses RLS** |
| Server components with user session | `createClient` from `@/utils/supabase/server` (anon key + cookies) |
| Browser | `createClient` from `@/utils/supabase/client` |

`src/lib/supabase.ts` accepts `SUPABASE_SERVICE_KEY` (the name `amplify.yml` writes) or `SUPABASE_SERVICE_ROLE_KEY` (the name in the docs).

## Mock mode

If the URL or key is missing or a placeholder, all three clients return `mockClient` (`src/utils/supabase/mockClient.ts`), backed by `mock_db.json` in the repo root (gitignored). It supports a subset of the query builder (`select`, `eq`, `in`, `order`, `single`, insert, update, delete, and a storage stub). It has **no `.or()`, `.not()` or `.maybeSingle()`**. In mock mode, validation's supplier-mapping lookup and duplicate check therefore throw, get caught and logged, and are skipped. Mock-mode results don't prove those features work. Debug route: `src/app/api/mock-db/route.ts`.

## Schema change checklist

1. Change the schema in Supabase (ask Nadav, because there are no migrations in the repo).
2. Run `npm run db:pull-types`. This writes `src/shared/supabase-types.ts`, which **doesn't exist in the repo yet**, so the first run creates it. It needs `npx supabase login` or `SUPABASE_ACCESS_TOKEN`.
3. Update `src/shared/types.ts` **and** `src/shared/schemas.ts`, plus the initial tables in `src/utils/supabase/mockDb.ts` if a table was added.
4. Update this skill's table list.

## Gotchas

- Types and schemas have already drifted: `ExtractedDataSchema` lacks the `bank_*` fields, `FieldBboxSchema` lacks `page`, and `InvoiceSchema.status` lacks `rejected`. Fix them when you touch them.
- `docs/db_schema.md` points to `supabase-types.ts` as the source of truth, but the file isn't committed. Until it is, this table list is reverse-engineered from queries.
- Signed URLs expire after a year. Old invoices will lose their file links.

---
Finished the task? Run the `self-improve` skill.
