import { NextResponse } from 'next/server';
import { compiledGraph } from '@/agents/supervisor';
import { resumeApproval } from '@/agents/approval';

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

    // Resume the graph execution at the paused 'approval' checkpoint
    await resumeApproval(compiledGraph, id, validatedData);

    return NextResponse.json({ success: true, message: 'Workflow resumed and completed' });
  } catch (err) {
    console.error(`Error resuming workflow for invoice ${id}:`, err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
