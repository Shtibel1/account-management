import { StateGraph, END, MemorySaver } from '@langchain/langgraph';
import type { PipelineState, TenantRules, ExtractedData } from '@/shared/types';
import { preprocessInvoice } from '../preprocessor';
import { extractInvoiceData } from '../extraction';
import { validateInvoice } from '../validation';
import { approvalNode } from '../approval';
import { supabase } from '@/lib/supabase';
import { PDFDocument } from 'pdf-lib';

async function splitPdfBuffer(
  fileBuffer: Buffer,
  startPage: number,
  endPage: number
): Promise<Buffer> {
  const originalDoc = await PDFDocument.load(fileBuffer);
  const newDoc = await PDFDocument.create();
  
  const pagesToCopy = [];
  for (let i = startPage - 1; i <= endPage - 1; i++) {
    pagesToCopy.push(i);
  }
  
  const copiedPages = await newDoc.copyPages(originalDoc, pagesToCopy);
  copiedPages.forEach((page) => newDoc.addPage(page));
  
  const pdfBytes = await newDoc.save();
  return Buffer.from(pdfBytes);
}


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
    const { rawOcrText, ocrMetadata, ocrOpCount, splits, pageTexts } = await preprocessInvoice(state.fileUrl, state.mimeType);
    const updatedMetrics = {
      ...state.costMetrics,
      ocrOpCount: state.costMetrics.ocrOpCount + ocrOpCount,
    };
    updatedMetrics.estimatedCostUsd = calculateEstimatedCost(updatedMetrics);

    console.log(`[Supervisor] ⚙️ Preprocessing complete. OCR Ops: ${updatedMetrics.ocrOpCount}, Cost: $${updatedMetrics.estimatedCostUsd}`);

    if (splits && splits.length > 1) {
      console.log(`[Supervisor] ✂️ Multi-invoice PDF detected. Splitting into ${splits.length} parts...`);
      try {
        const response = await fetch(state.fileUrl);
        if (!response.ok) {
          throw new Error(`Failed to download original invoice file: ${response.statusText}`);
        }
        const fileBuffer = Buffer.from(await response.arrayBuffer());

        const { data: currentInvoice, error: fetchInvErr } = await supabase
          .from('invoices')
          .select('file_name')
          .eq('id', state.invoiceId)
          .single();

        if (fetchInvErr || !currentInvoice) {
          throw new Error(`Failed to fetch current invoice: ${fetchInvErr?.message}`);
        }

        const originalFileName = currentInvoice.file_name || 'invoice.pdf';
        const lastDot = originalFileName.lastIndexOf('.');
        const ext = lastDot !== -1 ? originalFileName.substring(lastDot) : '.pdf';
        const nameWithoutExt = lastDot !== -1 ? originalFileName.substring(0, lastDot) : originalFileName;

        let primaryFileUrl = state.fileUrl;
        let primaryFileName = originalFileName;
        let primaryRawOcrText = rawOcrText;
        let primaryOcrMetadata = ocrMetadata;

        for (let idx = 0; idx < splits.length; idx++) {
          const split = splits[idx];
          const splitBuffer = await splitPdfBuffer(fileBuffer, split.start_page, split.end_page);
          const splitFileName = `${nameWithoutExt}_חלק_${idx + 1}${ext}`;
          const uploadPath = `${state.tenantId}/${Date.now()}_${splitFileName}`;

          const { data: uploadData, error: uploadErr } = await supabase.storage
            .from('raw-invoices')
            .upload(uploadPath, splitBuffer, {
              contentType: 'application/pdf',
              upsert: true,
            });

          if (uploadErr || !uploadData) {
            throw new Error(`Failed to upload split PDF part ${idx + 1}: ${uploadErr?.message}`);
          }

          console.log(`[Supervisor]   - Part ${idx + 1}/${splits.length} split and uploaded to Storage.`);

          const { data: signedData, error: signErr } = await supabase.storage
            .from('raw-invoices')
            .createSignedUrl(uploadPath, 60 * 60 * 24 * 365);

          if (signErr || !signedData?.signedUrl) {
            throw new Error(`Failed to create signed URL for split PDF part ${idx + 1}: ${signErr?.message}`);
          }

          const splitFileUrl = signedData.signedUrl;
          const splitPageTexts = pageTexts ? pageTexts.slice(split.start_page - 1, split.end_page) : [];
          const splitRawOcrText = splitPageTexts.join('\n\n');
          const splitPageCount = split.end_page - split.start_page + 1;
          const splitOcrMetadata = {
            pageCount: splitPageCount,
            detectedLanguages: ocrMetadata?.detectedLanguages || ['he'],
            confidence: ocrMetadata?.confidence || 0.95,
          };

          if (idx === 0) {
            primaryFileUrl = splitFileUrl;
            primaryFileName = splitFileName;
            primaryRawOcrText = splitRawOcrText;
            primaryOcrMetadata = splitOcrMetadata;

            await supabase
              .from('invoices')
              .update({
                file_url: splitFileUrl,
                file_name: splitFileName,
                updated_at: new Date().toISOString(),
              })
              .eq('id', state.invoiceId);
          } else {
            const { data: newInvoice, error: insertErr } = await supabase
              .from('invoices')
              .insert({
                client_id: state.tenantId,
                file_url: splitFileUrl,
                file_name: splitFileName,
                status: 'processing',
              })
              .select()
              .single();

            if (insertErr || !newInvoice) {
              console.error(`[Supervisor] Failed to insert split invoice part ${idx + 1}:`, insertErr);
              continue;
            }

            console.log(`[Supervisor]   - Triggered child pipeline for part ${idx + 1}: ${newInvoice.id}`);
            runOrchestrationPipeline(newInvoice.id, splitFileUrl, 'application/pdf', state.tenantId).catch((err) => {
              console.error(`LangGraph Pipeline failed for split invoice ${newInvoice.id}:`, err);
            });
          }
        }

        return {
          fileUrl: primaryFileUrl,
          rawOcrText: primaryRawOcrText,
          ocrMetadata: primaryOcrMetadata,
          costMetrics: updatedMetrics,
        };
      } catch (err) {
        console.error('[Supervisor] Splitting PDF failed, proceeding with original PDF:', err);
      }
    }

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
    
    console.log(`[Supervisor] 🔍 Extracting invoice fields (Retry: ${isRetry}, Vision Mode: ${useVision})`);

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

    console.log(`[Supervisor] 📄 Extraction complete. LLM Cost: $${(updatedMetrics.estimatedCostUsd - (updatedMetrics.ocrOpCount * 0.0015)).toFixed(4)} (Total cost: $${updatedMetrics.estimatedCostUsd})`);

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
    
    console.log(`[Supervisor] 💾 Saving state: REQUIRES MANUAL REVIEW (Total Cost: $${state.costMetrics.estimatedCostUsd})`);

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

    console.log(`[Supervisor] ✅ Saving state: AUTO-APPROVED (Total Cost: $${state.costMetrics.estimatedCostUsd})`);

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
    console.error(`[Supervisor] ❌ Saving state: ERROR (Total Cost: $${state.costMetrics.estimatedCostUsd}). Details: ${state.error}`);
    
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
