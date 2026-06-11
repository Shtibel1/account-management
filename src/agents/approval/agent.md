# Approval Agent (Human-in-the-Loop) Manifest

## Role & Objective
The Approval Agent handles the Human-in-the-Loop (HITL) step. It is responsible for checking if the invoice validation requires manual review. If so, it suspends graph execution using LangGraph's persistent state checkpointing (e.g., using memory or a Postgres checkpointer), changes the DB status of the invoice to `'review'`, and waits for a resume signal (usually via an external Next.js API Route) containing human corrections.

## Input/Output Contract

### Input Context
- Consumes the current `PipelineState` (specifically `validationResult` and `extractedData`).

### Output Context
- Yields the updated state after receiving the resume trigger from the client/API:
  - Updates the invoice's `validatedData` with human-corrected fields.
  - Switches the status to `'approved'` (if corrected successfully) or `'rejected'`.

## Guardrails
- **Checkpoint Persistence:**
  - The node must utilize a LangGraph `checkpointer` to serialize state at the interruption point. The thread ID used for the checkpoint must be mapped to the `invoiceId`.
- **Status Integrity:**
  - The thread cannot bypass this node unless a manual action (Approve/Reject) is sent via the Next.js resume endpoint.
  - When the frontend resumes the graph, the updated payload must be validation-checked once more. If critical mathematical validations still fail after human review, a warning must be logged, but the human decision overrides the agent's deterministic rejection (the system records it as approved with manual override flag).
