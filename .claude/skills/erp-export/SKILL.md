---
name: erp-export
description: Exporting approved invoices to accounting ERP files - the Move-in fixed-width format, Windows-1255 encoding, visual (reversed) Hebrew, account-code mappings (supplier/category, fallback 3499), and how to add a new exporter. Use when touching src/lib/exporters/, src/app/api/export/, src/utils/encoding.ts, or the mappings page.
---

# ERP export

Last verified against code: 2026-10-29

## Flow (`POST /api/export`, `src/app/api/export/route.ts`)

1. Body `{ ids }`. Loads only the invoices with `status = 'approved'`.
2. Takes the client from the **first** invoice and loads `clients` + `account_mappings` for that client.
3. If any `expense_category` has no `category` mapping, it returns **422** `{ error:'מיפויים חסרים', missing:[...] }`. The UI (`src/lib/api.ts`) shows this list.
4. `new MoveinExporter().export(invoices, mappings, client.vat_account)` returns a Buffer.
5. Marks **all requested ids** as `status:'exported'` and sets `exported_at`.
6. Returns `movein.dat`.

## Move-in format (`src/lib/exporters/movein.ts`)

- One line per invoice, joined with CRLF, plus a trailing CRLF, and the whole content encoded as Windows-1255.
- The line is fixed-width. Every field is **right-aligned** (`padStart`) and truncated to its width. The offsets are commented inline in `buildLine`. Don't reorder the fields.
- Hebrew fields (supplier name, `"מעמ ע"`, bank details) go through `toVisualHebrew`. The transaction type `"לח"` is written as-is.
- Data comes from `validated_data ?? extracted_data`.
- Supplier account: the mapping by `supplier_name`, or **`3499` (ספקים שונים)** when there's no mapping. Category account: the mapping, or empty.

## Encoding (`src/utils/encoding.ts`)

- `toVisualHebrew`: reverses the whole string, then re-reverses each digit run. **Latin text is NOT re-reversed**, despite the docstring ("keeps English LTR"). For example, "ABC בע״מ" comes out with "CBA".
- `encodeWindows1255`: maps א–ת to 0xE0–0xFA, ״ to `"`, ׳ to `'`, keeps code points ≤ 0xFF as-is, and turns everything else into `?`. Final letters are inside the א–ת range and are handled. Niqqud and other Hebrew symbols become `?`.

## Adding an exporter

`PROJECT_CONTEXT.md` asks for a shared exporter interface (OCP), but it doesn't exist yet: the route instantiates `MoveinExporter` directly. When adding a second format, introduce the interface (`export(invoices, mappings, clientVatAccount): Buffer`) and select the exporter by a request param. Don't add `if` branches inside `MoveinExporter`.

## Gotchas

- Step 5 marks **all** requested `ids` as exported, including ones that step 1 filtered out because they weren't approved.
- The response `Content-Type` is `text/plain; charset=utf-8`, but the bytes are Windows-1255. Fine for download, misleading for previews.
- Exporting invoices from mixed clients uses the first invoice's client and mappings for all of them.

## Verify

Generate a buffer from a fixture invoice and check: the byte length per line equals the sum of the widths (332 characters), Hebrew bytes are in 0xE0–0xFA, amounts use 2 decimals, and the date is `DD/MM/YYYY`.

---
Finished the task? Run the `self-improve` skill.
