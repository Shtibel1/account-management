import type { PipelineState, ExtractedData } from '@/shared/types';
import { supabase } from '@/lib/supabase';
import { computeConfidence } from '@/shared/confidence';
import { APPROVABLE_STATUSES } from '@/shared/invoiceStatus';
import { transitionInvoice, type TransitionOutcome } from '@/lib/invoiceTransitions';

/**
 * Finalizes a human approval: writes the (already server-validated) data, status 'approved' and
 * reviewed_at in ONE conditional update that only applies while the invoice is still awaiting
 * review. An exported / already approved / failed / processing invoice is never moved back to
 * 'approved' (it could otherwise be exported to the books twice).
 */
export async function finalizeApproval(invoiceId: string, finalData: ExtractedData): Promise<TransitionOutcome> {
  return transitionInvoice(supabase, invoiceId, APPROVABLE_STATUSES, {
    validated_data: finalData,
    status: 'approved',
    ai_confidence: computeConfidence(finalData),
    reviewed_at: new Date().toISOString(),
  });
}

/**
 * The approval node is executed after the graph resumes from human interruption.
 * At this point, the human has reviewed and approved/modified the invoice data,
 * so we can finalize it.
 */
export async function approvalNode(state: PipelineState): Promise<Partial<PipelineState>> {
  const finalData = state.extractedData;

  if (!finalData) {
    return {
      status: 'error',
      error: 'Missing extracted data at approval node',
    };
  }

  const outcome = await finalizeApproval(state.invoiceId, finalData);
  if (!outcome.ok) {
    console.error(`Failed to finalize approval of invoice ${state.invoiceId}:`, outcome);
    return {
      status: 'error',
      error: outcome.reason === 'conflict' ? 'Invoice is no longer awaiting review' : `DB update failed: ${outcome.error.message}`,
    };
  }

  return {
    status: 'approved',
    error: null,
  };
}

/**
 * Closes a paused pipeline thread after the approve route already finalized the approval:
 * records the approval node as done (no second DB write) so the checkpoint doesn't stay pending.
 */
export async function resumeApproval(
  compiledGraph: {
    updateState: (config: { configurable: { thread_id: string } }, values: Record<string, unknown>, asNode?: string) => Promise<unknown>;
  },
  invoiceId: string,
  correctedData: ExtractedData
): Promise<void> {
  const config = { configurable: { thread_id: invoiceId } };
  await compiledGraph.updateState(config, { extractedData: correctedData, status: 'approved' }, 'approval');
}
