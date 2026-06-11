import { StateGraph, END, MemorySaver } from '@langchain/langgraph';
import type { PipelineState, TenantRules, ExtractedData } from '@/shared/types';
import { preprocessInvoice } from '../preprocessor';
import { extractInvoiceData } from '../extraction';
import { validateInvoice } from '../validation';
import { approvalNode } from '../approval';
import { supabase } from '@/lib/supabase';

// Helper to compute confidence (Legacy calculation method)
export function computeConfidence(data: ExtractedData | null): number {
  if (!data) return 0;

  const critical: (keyof ExtractedData)[] = [
    'supplier_name', 'invoice_date', 'total_amount',
  ];
  const secondary: (keyof ExtractedData)[] = [
    'supplier_vat_id', 'invoice_number', 'amount_before_vat', 'vat_amount', 'expense_category',
  ];

  const criticalScore = critical.filter((f) => data[f] != null).length / critical.length;
  const secondaryScore = secondary.filter((f) => data[f] != null).length / secondary.length;
  const base = criticalScore * 0.6 + secondaryScore * 0.4;

  const flags = data.validation_flags;
  let penalty = 0;
  if (flags) {
    if (!flags.math_ok) penalty += 0.25;
    if (!flags.vat_id_ok) penalty += 0.10;
    if ((flags.warnings ?? []).length > 0) {
      penalty += 0.05 * Math.min((flags.warnings ?? []).length, 2);
    }
  }

  return Math.max(0.1, Math.round((base - penalty) * 100) / 100);
}

// Fetch dynamic tenant rules helper
export async function getTenantRules(tenantId: string): Promise<TenantRules> {
  const defaultRules: TenantRules = {
    maxAmountForAutoApprove: 1000,
    requireVatId: true,
    requireInvoiceDate: true,
    requireExpenseCategory: true,
    allowedExpenseCategories: [
      'ציוד משרדי',
      'שכ"ד',
      'תקשורת',
      'שיווק ופרסום',
      'נסיעות',
      'אחזקה',
      'שירותים מקצועיים',
      'חשמל ומים',
      'אחר'
    ],
    duplicateInvoiceCheck: true,
  };

  try {
    const { data, error } = await supabase
      .from('clients')
      .select('rules')
      .eq('id', tenantId)
      .single();

    if (error || !data || !data.rules) {
      return defaultRules;
    }

    return {
      ...defaultRules,
      ...(data.rules as Partial<TenantRules>),
    };
  } catch (e) {
    console.warn(`Error fetching rules for tenant ${tenantId}, using defaults.`, e);
    return defaultRules;
  }
}

// Calculate token and OCR costs for billing
export function calculateEstimatedCost(metrics: {
  ocrOpCount: number;
  inputTokens: number;
  outputTokens: number;
}): number {
  const ocrCost = metrics.ocrOpCount * 0.0015; // $1.50 per 1000 pages ($0.0015 each)
  const inputCost = (metrics.inputTokens / 1_000_000) * 3.00; // Claude 4.5 Sonnet: $3.00/MTok
  const outputCost = (metrics.outputTokens / 1_000_000) * 15.00; // Claude 4.5 Sonnet: $15.00/MTok
  return Math.round((ocrCost + inputCost + outputCost) * 10000) / 10000;
}

// Define the StateGraph channels as any to bypass LangGraph's internal TS engine issues
const graph = new StateGraph<any>({
  channels: {
    invoiceId:        { value: (a: string, b: string) => b ?? a, default: () => '' },
    fileUrl:          { value: (a: string, b: string) => b ?? a, default: () => '' },
    mimeType:         { value: (a: string, b: string) => b ?? a, default: () => '' },
    tenantId:         { value: (a: string, b: string) => b ?? a, default: () => '' },
    tenantRules:      { value: (a: any, b: any) => b ?? a, default: () => null },
    rawOcrText:       { value: (a: any, b: any) => b ?? a, default: () => null },
    ocrMetadata:      { value: (a: any, b: any) => b ?? a, default: () => null },
    extractedData:    { value: (a: any, b: any) => b ?? a, default: () => null },
    validationResult: { value: (a: any, b: any) => b ?? a, default: () => null },
    retryCount:       { value: (a: number, b: number) => b ?? a, default: () => 0 },
    status:           { value: (a: any, b: any) => b ?? a, default: () => 'processing' },
    error:            { value: (a: any, b: any) => b ?? a, default: () => null },
    costMetrics:      {
      value: (a: any, b: any) => b ?? a,
      default: () => ({ ocrOpCount: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }),
    },
    useVisionFallback: { value: (a: boolean, b: boolean) => b ?? a, default: () => false },
  },
})
  // 1. Initialize Rules node
  .addNode('init_rules', async (state: PipelineState) => {
    const rules = await getTenantRules(state.tenantId);
    return { tenantRules: rules };
  })

  // 2. Preprocess node (Deterministic OCR Extraction)
  .addNode('preprocess', async (state: PipelineState) => {
    const { rawOcrText, ocrMetadata, ocrOpCount } = await preprocessInvoice(state.fileUrl, state.mimeType);
    const updatedMetrics = {
      ...state.costMetrics,
      ocrOpCount: state.costMetrics.ocrOpCount + ocrOpCount,
    };
    updatedMetrics.estimatedCostUsd = calculateEstimatedCost(updatedMetrics);

    console.log(`[Supervisor] Preprocessed invoice. OCR ops: ${updatedMetrics.ocrOpCount}, cost: $${updatedMetrics.estimatedCostUsd}`);

    return {
      rawOcrText,
      ocrMetadata,
      costMetrics: updatedMetrics,
    };
  })

  // 3. Extract Data node (Text-first with vision fallback)
  .addNode('extract', async (state: PipelineState) => {
    const isRetry = state.extractedData !== null;
    const useVision = state.useVisionFallback || isRetry;
    
    console.log(`[Supervisor] Extracting data. Retry: ${isRetry}, useVision: ${useVision}`);

    const { extractedData, inputTokens, outputTokens } = await extractInvoiceData(
      state.rawOcrText,
      state.fileUrl,
      state.mimeType,
      useVision,
      isRetry
    );

    const updatedMetrics = {
      ...state.costMetrics,
      inputTokens: state.costMetrics.inputTokens + inputTokens,
      outputTokens: state.costMetrics.outputTokens + outputTokens,
    };
    updatedMetrics.estimatedCostUsd = calculateEstimatedCost(updatedMetrics);

    console.log(`[Supervisor] Extracted invoice data. LLM Input tokens: ${updatedMetrics.inputTokens}, Output tokens: ${updatedMetrics.outputTokens}, Total cost: $${updatedMetrics.estimatedCostUsd}`);

    return { 
      extractedData,
      costMetrics: updatedMetrics,
      retryCount: isRetry ? state.retryCount + 1 : state.retryCount,
      useVisionFallback: useVision
    };
  })

  // 4. Deterministic Validation node
  .addNode('validate', async (state: PipelineState) => {
    if (!state.extractedData || !state.tenantRules) {
      throw new Error('Missing extraction data or rules for validation');
    }
    const { data: validated, validationResult } = await validateInvoice(
      state.invoiceId,
      state.tenantId,
      state.extractedData,
      state.tenantRules
    );
    return { extractedData: validated, validationResult };
  })

  // 5. Save review node (Interrupt point before approval)
  .addNode('save_review', async (state: PipelineState) => {
    const data = state.extractedData;
    const confidence = computeConfidence(data);
    
    console.log(`[Supervisor] Saving review state. Total Pipeline Cost: $${state.costMetrics.estimatedCostUsd}`);

    await supabase.from('invoices').update({
      extracted_data: data,
      validated_data: data,
      status: 'review',
      ai_confidence: confidence,
      updated_at: new Date().toISOString(),
    }).eq('id', state.invoiceId);

    return { status: 'review' };
  })

  // 6. Approval node (HITL node) - Cast to any to align with StateGraph<any>
  .addNode('approval', approvalNode as any)

  // 7. Save Auto-Approved node
  .addNode('save_success', async (state: PipelineState) => {
    const data = state.extractedData;
    const confidence = computeConfidence(data);

    console.log(`[Supervisor] Saving success/approved state. Total Pipeline Cost: $${state.costMetrics.estimatedCostUsd}`);

    await supabase.from('invoices').update({
      extracted_data: data,
      validated_data: data,
      status: 'approved',
      ai_confidence: confidence,
      updated_at: new Date().toISOString(),
    }).eq('id', state.invoiceId);

    return { status: 'approved' };
  })

  // 8. Save Error node
  .addNode('save_error', async (state: PipelineState) => {
    console.error(`[Supervisor] Saving error state. Total Pipeline Cost: $${state.costMetrics.estimatedCostUsd}. Error: ${state.error}`);
    
    await supabase.from('invoices').update({
      status: 'error',
      error_message: state.error || 'Unknown error occurred in pipeline',
      updated_at: new Date().toISOString(),
    }).eq('id', state.invoiceId);

    return { status: 'error' };
  })

  // Define Graph Edges
  .addEdge('__start__', 'init_rules')
  .addEdge('init_rules', 'preprocess')
  .addEdge('preprocess', 'extract')
  .addEdge('extract', 'validate')
  
  // Conditional Edge after validation
  .addConditionalEdges('validate', (state: PipelineState) => {
    const result = state.validationResult;
    if (!result) return 'save_error';

    // Mathematical retry loop
    if (!result.math_ok && state.retryCount < 1) {
      return 'retry';
    }

    // HITL vs Auto-approve route
    if (result.requires_manual_review) {
      return 'save_review';
    }

    return 'save_success';
  }, {
    retry: 'extract',
    save_review: 'save_review',
    save_success: 'save_success',
    save_error: 'save_error'
  })

  // Map other nodes to their end states or next steps
  .addEdge('save_review', 'approval')
  .addEdge('approval', END)
  .addEdge('save_success', END)
  .addEdge('save_error', END);

// Compile the graph with persistent memory checkpointer & interrupt before manual approval
export const checkpointer = new MemorySaver();
export const compiledGraph = graph.compile({
  checkpointer,
  interruptBefore: ['approval'],
});

/**
 * Executes the entire orchestrator flow asynchronously.
 */
export async function runOrchestrationPipeline(
  invoiceId: string,
  fileUrl: string,
  mimeType: string,
  tenantId: string
): Promise<void> {
  try {
    await compiledGraph.invoke(
      {
        invoiceId,
        fileUrl,
        mimeType,
        tenantId,
        retryCount: 0,
        status: 'processing',
        rawOcrText: null,
        ocrMetadata: null,
        costMetrics: { ocrOpCount: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
        useVisionFallback: false,
      },
      { configurable: { thread_id: invoiceId } }
    );
  } catch (err) {
    console.error(`Orchestration pipeline execution error for ${invoiceId}:`, err);
    await supabase.from('invoices').update({
      status: 'error',
      error_message: err instanceof Error ? err.message : String(err),
      updated_at: new Date().toISOString(),
    }).eq('id', invoiceId);
    throw err;
  }
}
