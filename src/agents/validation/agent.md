# Validation Agent Manifest

## Role & Objective
The Validation Agent is a deterministic TypeScript module that evaluates extracted invoice data against:
1. Universal Hebrew business/tax rules (such as Israeli VAT structure and Luhn checksum checks).
2. Dynamic tenant-specific configurations (such as auto-approve thresholds, category whitelists, and duplicate invoice protection).

It updates the pipeline state with specific rule violations or warnings, deciding if an invoice requires manual human review.

## Input/Output Contract

### Input Context
- `extractedData`: `ExtractedData`
- `tenantRules`: `TenantRules`

### Output Interface (`ValidationResult`)
```typescript
export interface ValidationResult {
  math_ok: boolean;               // True if amount_before_vat + vat_amount === total_amount
  vat_id_ok: boolean;             // True if supplier_vat_id passes Israeli checksum or is empty when not required
  fields_missing: string[];       // List of missing required fields
  duplicate_found: boolean;       // True if invoice exists in DB for tenant/supplier/number
  rule_violations: string[];      // List of failed tenant rules
  warnings: string[];             // General warnings (e.g. exempt supplier checks, credit notes)
  requires_manual_review: boolean;// True if any rule or mathematical check fails
}
```

## Guardrails
- **Mathematical Tolerance:**
  - Standard floating-point mathematics: `Math.abs((amount_before_vat + vat_amount) - total_amount) <= 1.00`. Allow up to 1.00 ILS/unit tolerance for rounding variations.
- **Israeli VAT Checksum Validation:**
  - If a VAT ID is present, validate using the Israeli Luhn checksum algorithm:
    ```typescript
    function checkVatId(vatId: string): boolean {
      const digits = vatId.replace(/\D/g, '');
      if (digits.length !== 9) return false;
      let sum = 0;
      for (let i = 0; i < 9; i++) {
        let d = parseInt(digits[i]);
        if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
        sum += d;
      }
      return sum % 10 === 0;
    }
    ```
- **Auto-Correction / Edge Case Handlers:**
  - If mathematical validation fails but `total_amount` minus `vat_amount` matches the invoice within rounding boundaries, auto-correct `amount_before_vat` and append a warning: `"סכום לפני מע\"מ תוקן אוטומטית ל-₪... (= סה\"כ - מע\"מ)"`.
  - Flags if supplier has zero or null VAT and marks as an exempt supplier.
  - Flags negative amounts as credit notes.
- **Manual Review Trigger:**
  - If `requires_manual_review` is true, the supervisor will route the graph to the HITL approval state.
  - `requires_manual_review` is false ONLY when the client opted the supplier (by VAT ID) into auto-approve (`supplier_automation.auto_approve`) AND math/VAT ID are OK, no fields are missing, no rule violations, no duplicate (and the duplicate check actually ran), the document is an invoice, the amounts were not auto-corrected and the VAT ID was read from the invoice (not filled / replaced from the supplier table or web search). Otherwise it is true, and for an opted-in supplier the reasons go to `auto_approve_blockers`. See `docs/supplier_automation.md`.
- **Supplier Rules:**
  - The supplier's rule (`account_mappings`, type `supplier`, matched by VAT ID then name) is applied before the supplier-name / category checks; its values go to `validated_data` only (via the `supplierRule` graph channel), never `extracted_data`.
