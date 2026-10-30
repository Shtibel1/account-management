# Supplier Rules & Per-Supplier Auto-Approve

Two Dext-style features that cut review work for repeat suppliers.

---

## 1. Supplier rules

A supplier rule is a row in `account_mappings` with `mapping_type = 'supplier'` (no separate table):

| Column             | Role on the invoice                                                                 |
|--------------------|-------------------------------------------------------------------------------------|
| `key`              | Canonical supplier name → `validated_data.supplier_name` (the export resolves the ledger account by it). Rules on the catch-all account `3499` set `ספקים שונים`, matching the review form. |
| `account_code`     | Supplier ledger account (looked up by name at export time)                          |
| `vat_id`           | Preferred match key                                                                 |
| `expense_category` | Default category → `validated_data.expense_category`                                |

**Matching** (`findSupplierRule` in `src/shared/supplierRules.ts`): VAT ID first (normalized: digits only, 8 digits padded to 9), then the supplier name the AI read. Among several VAT matches, one whose name also matches wins.

**Precedence** for each rule field, highest first:

1. **Explicit reviewer edit** on the invoice: a value that is neither the AI's nor what a rule filled in.
2. **Supplier rule**.
3. **AI extraction**.

Rules only ever write `validated_data`. `extracted_data` stays the AI output. The values a rule filled in are recorded in `validated_data.supplier_rule` (`{ mapping_id, applied, applied_at }`). A later re-apply can then tell a rule-filled value (safe to overwrite, or to revert to the AI value when the rule stops setting it) from a reviewer edit (kept).

**When rules are applied**
- **Pipeline:** the validation node finds the rule and runs the supplier-name / category checks on the rule's values. The save nodes write them into `validated_data`.
- **Re-apply** (`POST /api/suppliers/rules/apply`, `reapplySupplierRules` in `src/lib/supplierAutomation.ts`): runs on the client's invoices still in `review` when a rule is saved, edited, deleted or imported. Triggers:
  - the mappings page (add / edit / delete / Excel import);
  - the review form: a new supplier with a code, or the "save as the supplier's default category" checkbox.

**Corrections:** `recordCorrections` diffs the approved data against the *system proposal*, which is the AI output plus the supplier rule's values (`systemProposal`). Accepting a rule default is therefore not a correction. Changing it is.

---

## 2. Per-supplier auto-approve

**Eligibility** (a suggestion only, `computeSupplierEligibility` in `src/shared/autoApprove.ts`): for a client and supplier VAT ID, the last `AUTO_APPROVE_HISTORY_SIZE` (5) human-reviewed invoices (`reviewed_at` set, status approved/exported) had zero `invoice_corrections` rows.

**Opt-in:** table `supplier_automation` (`client_id`, `supplier_vat_id`, `auto_approve`, `enabled_at`, `disabled_at`, `disabled_reason`, `disabled_by_invoice_id`). The mappings page shows an eligibility badge and a toggle per supplier with a VAT ID. The server only lets you turn auto-approve on for an eligible supplier (`409` otherwise). Turning it off is always allowed.

**Pipeline** (validation node): `requires_manual_review` is `false` only when all of these hold:
- the supplier is opted in;
- `math_ok` and `vat_id_ok`;
- no `fields_missing`;
- no `rule_violations` (this includes the tenant's `maxAmountForAutoApprove` and the allocation-number rule);
- no duplicate;
- not `not_an_invoice`.

It also fails closed when any of these hold:
- the duplicate check did not run (it was skipped or its query failed);
- the edge-case handlers had to rewrite the amounts;
- the supplier VAT ID is missing.

For an opted-in supplier that still needs review, the reasons are stored in `validation_flags.auto_approve_blockers` and shown in the review form.

Auto-approved invoices go through `save_success`: status `approved`, `validation_flags.auto_approved = true`, and **no `reviewed_at`**. They don't count toward accuracy or eligibility.

**Auto-revert:** when a human approval of that supplier records corrections, `disableAutoApproveAfterCorrections` turns the opt-in off with `disabled_reason = 'corrections'`. This runs in the approve route, right after `recordCorrections`. The mappings page shows "כובה עקב תיקון". The supplier has to build a new clean streak before it can be turned on again.

**Mock DB:** every query uses only the calls the local mock supports. A missing table means no rules and not opted in. The duplicate check uses `.or()`, which the mock lacks, so under the mock DB invoices are never auto-approved (fail closed).
