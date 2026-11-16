---
name: israeli-invoice-rules
description: Israeli tax-invoice domain rules as implemented here - VAT ID (ח.פ./עוסק מורשה) checksum and 8-digit padding, amount/VAT math and auto-correction, exempt suppliers, credit notes, expense categories, tenant rules, duplicate detection, and supplier VAT lookup via data.gov.il. Use when changing validation, extraction field semantics, tenant rules, or anything that decides whether an invoice is correct.
---

# Israeli invoice rules (validation)

Last verified against code: 2026-10-29

Main file: `src/agents/validation/index.ts` (`validateInvoice`). Lookup: `src/utils/businessLookup.ts`.

## Order of operations in `validateInvoice`

1. `runEdgeCaseHandlers`. **This mutates the data:**
   - If `|before + vat − total| > 1`, set `amount_before_vat = round(total − vat, 2)` and add a warning.
   - If `vat` is `0` or `null` and `total > 0`, set `vat = 0` and `before = total`, with an "exempt supplier" warning. Note that a *missing* VAT is therefore treated as exempt.
   - If `total < 0`, it's a credit note (warning only).
   - If there is no date, add a "maybe receipt only" warning.
2. Pad an 8-digit VAT ID with a leading `0`.
3. VAT ID sources, in priority order: **supplier mapping** (`account_mappings`, `mapping_type='supplier'`, `key = supplier_name`, column `vat_id`) overrides the invoice's value. **Gov.il lookup** fills it only when the invoice has none. All three sources are recorded in `validation_flags.vat_id_sources`.
4. `checkMath`: tolerance ₪1.00. Missing amounts count as OK.
5. `checkVatId`: 9 digits, Israeli Luhn (odd positions ×2, minus 9 if > 9, sum % 10 == 0). An empty ID counts as OK.
6. Missing fields, controlled by tenant rules (`requireVatId`, `requireInvoiceDate`, `requireExpenseCategory`). The amounts and `supplier_name` are always required.
7. Rule violations: total above `maxAmountForAutoApprove`, a category outside `allowedExpenseCategories`, a bad checksum when `requireVatId` is set, or a duplicate.
8. Duplicate check: same client, plus the `supplier_vat_id` and `invoice_number` found in either `extracted_data` or `validated_data` (JSONB `->>`), excluding the invoice itself.
9. `not_an_invoice` is set when supplier_name, invoice_number, total and before-VAT are all missing. The supervisor then routes to `save_error` with the message "המסמך לא זוהה כחשבונית".
10. `requires_manual_review = true` (always, for now).

## Amount semantics (shared with the extraction prompt)

- `total_amount` = סה"כ / לתשלום. `vat_amount` = מע"מ. `amount_before_vat` = **total − vat**, always.
- "אינו חייב מע"מ" (the exempt portion) is **not** `amount_before_vat`.
- Dates are `YYYY-MM-DD` in data. The export converts them to `DD/MM/YYYY`.

## Expense categories

The default whitelist is duplicated in **three** places: `getTenantRules` (supervisor), `TenantRulesSchema` (`src/shared/schemas.ts`) and the `expense_category` description in the extraction `TOOL_DEFINITION`. Change all three together. Per-client overrides come from `clients.rules.allowedExpenseCategories`.

## Gov.il supplier lookup (`searchVatIdByName`)

It queries data.gov.il CKAN in parallel for companies, partnerships and non-profits (resource IDs are in the file). It uses fuzzy name matching (strips בע"מ/LTD etc., then substring match, ≥60% token overlap, or first two words equal). **If nothing matches, it returns the first company record anyway.** That can attach a wrong VAT ID, but only when the invoice had no VAT ID at all.

## Gotchas

- `src/agents/validation/agent.md` shows a `checkVatId` without 8-digit padding. The code pads.
- Edge-case auto-correction runs before the math check, so `math_ok` rarely fails (see `invoice-pipeline`).
- Duplicate query values are interpolated into a PostgREST `.or()` string. An invoice number containing `,` or `)` will break the filter.

## Verify

Pure helpers (`checkVatId`, `checkMath`, `runEdgeCaseHandlers`) aren't exported or tested. If you change them, check with known values: a valid 9-digit ID, an 8-digit ID that needs padding, an invalid checksum, and the exempt, credit-note and rounding cases. Report which values you checked.

---
Finished the task? Run the `self-improve` skill.
