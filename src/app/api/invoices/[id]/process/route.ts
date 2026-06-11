import { NextResponse } from 'next/server';
import { runOrchestrationPipeline } from '@/agents/supervisor';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const body = await request.json();
    const { fileUrl, mimeType, tenantId } = body;

    if (!fileUrl || !mimeType || !tenantId) {
      return NextResponse.json({ error: 'Missing required body parameters' }, { status: 400 });
    }

    console.log(`[Process Route] 🚀 Starting synchronous pipeline execution for invoice ${id}`);

    // Await the pipeline run to completion (or pause at manual review)
    await runOrchestrationPipeline(id, fileUrl, mimeType, tenantId);

    console.log(`[Process Route] ✅ Synchronous pipeline finished/paused for invoice ${id}`);
    return NextResponse.json({ success: true, status: 'completed' });
  } catch (err) {
    console.error(`[Process Route] ❌ Pipeline execution failed for invoice ${id}:`, err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
