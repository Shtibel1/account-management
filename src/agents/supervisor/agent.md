# Supervisor Agent Manifest

## Role & Objective
The Supervisor Agent is the central orchestrator of the Invoice Validation LangGraph. Its primary responsibility is state management and routing. It receives the initial invoice pipeline request, reads the state, routes work to extraction, validation, and approval nodes, and manages state transitions based on intermediate outcomes (e.g., triggering retries or pausing for human-in-the-loop validation).

## Input/Output Contract
The Supervisor Agent manages the global **`PipelineState`** within the LangGraph context.

### State Interface (TypeScript)
```typescript
import { ExtractedData } from '../../shared/types';

export type InvoiceStatus = 'processing' | 'review' | 'approved' | 'exported' | 'error';

export interface PipelineState {
  // Input fields
  invoiceId: string;
  fileUrl: string;
  mimeType: string;
  tenantId: string;

  // Configuration loaded at runtime
  tenantRules: TenantRules | null;

  // Intermediate state
  extractedData: ExtractedData | null;
  validationResult: ValidationResult | null;
  retryCount: number;

  // Process outcome
  status: InvoiceStatus;
  error: string | null;
}

export interface TenantRules {
  maxAmountForAutoApprove: number;
  requireVatId: boolean;
  requireInvoiceDate: boolean;
  requireExpenseCategory: boolean;
  allowedExpenseCategories: string[];
  duplicateInvoiceCheck: boolean;
}

export interface ValidationResult {
  math_ok: boolean;
  vat_id_ok: boolean;
  fields_missing: string[];
  duplicate_found: boolean;
  rule_violations: string[];
  warnings: string[];
  requires_manual_review: boolean;
}
```

## Guardrails & Logic
- **Infinite Loop Prevention:** 
  - Maximum retry attempts for the extraction/validation loop is strictly capped at **2**. If the loop exceeds this limit, routing must immediately redirect to the `save_error` node.
- **Fail-Safe Processing:**
  - Any unexpected runtime exception during node execution must be caught, stored in the `error` state field, and route execution to a failure termination node which updates the database status of the invoice to `'error'`.
- **Stateless Routing:**
  - The supervisor does not call external business APIs directly; it determines the next node to execute based strictly on the current values of `extractedData`, `validationResult`, and `retryCount` in the state.
