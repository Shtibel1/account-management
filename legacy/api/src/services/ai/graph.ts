import { StateGraph, END } from '@langchain/langgraph';
import { extractInvoiceData } from './extract.js';
import { validateInvoiceData } from './validate.js';
import { supabase } from '../../lib/supabase.js';
import type { ExtractedData } from '@invoice/shared-types';

interface PipelineState {
  invoiceId: string;
  fileUrl: string;
  mimeType: string;
  extracted: ExtractedData | null;
  retryCount: number;
}

const graph = new StateGraph<PipelineState>({
  channels: {
    invoiceId:  { value: (a: string, b: string) => b ?? a, default: () => '' },
    fileUrl:    { value: (a: string, b: string) => b ?? a, default: () => '' },
    mimeType:   { value: (a: string, b: string) => b ?? a, default: () => '' },
    extracted:  { value: (_: any, b: any) => b ?? null, default: () => null },
    retryCount: { value: (_: number, b: number) => b ?? 0, default: () => 0 },
  },
})
  .addNode('extract', async (state) => {
    const extracted = await extractInvoiceData(state.fileUrl, state.mimeType);
    return { extracted };
  })
  .addNode('validate', async (state) => {
    if (!state.extracted) return {};
    const validated = validateInvoiceData(state.extracted);
    return { extracted: validated };
  })
  .addNode('retry', async (state) => {
    const extracted = await extractInvoiceData(state.fileUrl, state.mimeType, true);
    return { extracted, retryCount: state.retryCount + 1 };
  })
  .addNode('save', async (state) => {
    const data = state.extracted;
    const confidence = computeConfidence(data);
    await supabase.from('invoices').update({
      extracted_data: data,
      validated_data: data,
      status: 'review',
      ai_confidence: confidence,
    }).eq('id', state.invoiceId);
    return {};
  })
  .addEdge('__start__', 'extract')
  .addEdge('extract', 'validate')
  .addConditionalEdges('validate', (state) => {
    if (!state.extracted) return 'save';
    const flags = state.extracted.validation_flags;
    if (!flags.math_ok && state.retryCount < 1) return 'retry';
    return 'save';
  }, { retry: 'retry', save: 'save' })
  .addEdge('retry', 'validate')
  .addEdge('save', END);

const compiled = graph.compile();

export async function runExtractionPipeline(
  invoiceId: string,
  fileUrl: string,
  mimeType: string
): Promise<void> {
  try {
    await compiled.invoke({ invoiceId, fileUrl, mimeType, extracted: null, retryCount: 0 });
  } catch (err) {
    await supabase.from('invoices').update({
      status: 'error',
      error_message: err instanceof Error ? err.message : String(err),
    }).eq('id', invoiceId);
    throw err;
  }
}

function computeConfidence(data: ExtractedData | null): number {
  if (!data) return 0;

  // שדות חובה (משקל גבוה יותר)
  const critical: (keyof ExtractedData)[] = [
    'supplier_name', 'invoice_date', 'total_amount',
  ];
  // שדות משניים
  const secondary: (keyof ExtractedData)[] = [
    'supplier_vat_id', 'invoice_number', 'amount_before_vat', 'vat_amount', 'expense_category',
  ];

  const criticalScore = critical.filter((f) => data[f] != null).length / critical.length;
  const secondaryScore = secondary.filter((f) => data[f] != null).length / secondary.length;
  const base = criticalScore * 0.6 + secondaryScore * 0.4;

  const flags = data.validation_flags;
  let penalty = 0;
  if (!flags.math_ok) penalty += 0.25;
  if (!flags.vat_id_ok) penalty += 0.10;
  if ((flags.warnings ?? []).length > 0) penalty += 0.05 * Math.min((flags.warnings ?? []).length, 2);

  return Math.max(0, Math.round((base - penalty) * 100) / 100);
}
