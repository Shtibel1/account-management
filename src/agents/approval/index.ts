import type { PipelineState, ExtractedData } from '@/shared/types';
import { supabase } from '@/lib/supabase';

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

  // Calculate final confidence based on validation flags
  let finalConfidence = 1.0;
  if (finalData.validation_flags) {
    const flags = finalData.validation_flags;
    let penalty = 0;
    if (!flags.math_ok) penalty += 0.2;
    if (!flags.vat_id_ok) penalty += 0.1;
    if (flags.fields_missing.length > 0) penalty += 0.1 * flags.fields_missing.length;
    finalConfidence = Math.max(0.1, 1.0 - penalty);
  }

  // Update Supabase DB invoice status to approved
  const { error } = await supabase
    .from('invoices')
    .update({
      validated_data: finalData,
      status: 'approved',
      ai_confidence: finalConfidence,
      updated_at: new Date().toISOString(),
    })
    .eq('id', state.invoiceId);

  if (error) {
    console.error(`Failed to update DB for approved invoice ${state.invoiceId}:`, error);
    return {
      status: 'error',
      error: `DB update failed: ${error.message}`,
    };
  }

  return {
    status: 'approved',
    error: null,
  };
}

/**
 * Resume function to be called from Next.js Server Actions / API Routes.
 * Updates the graph checkpoint memory and signals LangGraph to continue.
 */
export async function resumeApproval(
  compiledGraph: any,
  invoiceId: string,
  correctedData: ExtractedData
): Promise<void> {
  const config = { configurable: { thread_id: invoiceId } };

  // 1. Update the state in checkpointer memory with user's corrected data
  await compiledGraph.updateState(config, {
    extractedData: correctedData,
    status: 'approved',
  });

  // 2. Resume graph execution by supplying null (since it's paused at interrupt)
  await compiledGraph.stream(null, config);
}
