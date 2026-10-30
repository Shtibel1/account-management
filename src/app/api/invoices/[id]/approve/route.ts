import { NextResponse } from 'next/server';
import { compiledGraph } from '@/agents/supervisor';
import { approvalNode, resumeApproval } from '@/agents/approval';
import { supabase } from '@/lib/supabase';
import { recordCorrections } from '@/lib/corrections';
import type { PipelineState } from '@/shared/types';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const body = await request.json();
    const validatedData = body.validated_data || body.validatedData;

    if (!validatedData) {
      return NextResponse.json({ error: 'Missing validated_data in request body' }, { status: 400 });
    }

    // Log what the reviewer changed vs. the AI output (before approval overwrites validated_data)
    const corrections = await recordCorrections(supabase, id, validatedData);

    // The MemorySaver checkpoint only lives in this server process; after a restart / on
    // another instance there is nothing to resume, so finalize the approval directly.
    const snapshot = await compiledGraph.getState({ configurable: { thread_id: id } });
    if (snapshot?.next?.includes('approval')) {
      // Resume the graph execution at the paused 'approval' checkpoint
      await resumeApproval(compiledGraph, id, validatedData);
    } else {
      const result = await approvalNode({ invoiceId: id, extractedData: validatedData } as PipelineState);
      if (result.status === 'error') {
        return NextResponse.json({ error: result.error }, { status: 500 });
      }
    }

    return NextResponse.json({
      success: true,
      message: 'Workflow resumed and completed',
      corrections: corrections.length,
    });
  } catch (err) {
    console.error(`Error resuming workflow for invoice ${id}:`, err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
