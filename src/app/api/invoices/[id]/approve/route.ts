import { NextResponse } from 'next/server';
import { compiledGraph } from '@/agents/supervisor';
import { finalizeApproval, resumeApproval } from '@/agents/approval';
import { supabase } from '@/lib/supabase';
import { recordCorrections } from '@/lib/corrections';
import { disableAutoApproveAfterCorrections } from '@/lib/supplierAutomation';
import type { ExtractedData, InvoiceStatus } from '@/shared/types';
import { requireInvoiceAccess } from '@/lib/auth';
import { dbErrorResponse, readJsonObject } from '@/lib/invoiceTransitions';
import { APPROVABLE_STATUSES, transitionRefusedMessage } from '@/shared/invoiceStatus';
import { validateApproval } from '@/shared/approvalValidation';
import { pruneFieldConfidence } from '@/shared/confidence';

interface ApproveInvoiceRow extends Record<string, unknown> {
  id: string;
  client_id: string;
  status: InvoiceStatus;
  extracted_data: ExtractedData | null;
  validated_data: ExtractedData | null;
}

/**
 * Human approval. Body: { validated_data }. Only an invoice awaiting review can be approved
 * (409 otherwise: exported / approved / processing / error …). The data is validated on the
 * server (types, real date, VAT math within ₪1, VAT-id checksum, allocation number when required)
 * and merged over the stored validated_data, then status + data + reviewed_at are written in one
 * conditional update, so a concurrent export or second approval can't be overwritten.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const access = await requireInvoiceAccess<ApproveInvoiceRow>(id, 'id, client_id, status, extracted_data, validated_data');
  if (!access.ok) return access.response;
  const invoice = access.value.invoice;

  const parsed = await readJsonObject<{ validated_data?: unknown; validatedData?: unknown }>(request);
  if (!parsed.ok) return parsed.response;
  const payload = parsed.body.validated_data ?? parsed.body.validatedData;
  if (payload === undefined || payload === null) {
    return NextResponse.json({ error: 'חסרים נתוני החשבונית לאישור (validated_data)' }, { status: 400 });
  }

  if (!APPROVABLE_STATUSES.includes(invoice.status)) {
    return NextResponse.json({ error: transitionRefusedMessage('approve', invoice.status), status: invoice.status }, { status: 409 });
  }

  const validation = validateApproval(payload, invoice.validated_data ?? invoice.extracted_data);
  if (!validation.ok) {
    return NextResponse.json({ error: validation.errors.join(' · '), errors: validation.errors }, { status: 400 });
  }
  const finalData = validation.data;
  // The payload is merged over the stored data, so a field_confidence the form dropped would come
  // back from the stored row: keep model confidences only for fields still as the AI extracted them.
  const confidence = pruneFieldConfidence(finalData.field_confidence, invoice.extracted_data, finalData);
  if (confidence) finalData.field_confidence = confidence;
  else delete finalData.field_confidence;

  try {
    const outcome = await finalizeApproval(id, finalData);
    if (!outcome.ok) {
      if (outcome.reason === 'conflict') {
        return NextResponse.json(
          { error: transitionRefusedMessage('approve', outcome.currentStatus), status: outcome.currentStatus },
          { status: 409 }
        );
      }
      return dbErrorResponse(outcome.error, 'שגיאה בשמירת האישור');
    }

    // Log what the reviewer changed vs. the system proposal as it was BEFORE this approval.
    const corrections = await recordCorrections(supabase, id, finalData, {
      before: { client_id: invoice.client_id, extracted_data: invoice.extracted_data, validated_data: invoice.validated_data },
      markReviewed: false, // set by finalizeApproval in the same update as the status
    });
    // A supplier that needed corrections is no longer trusted for auto-approve
    const autoApproveDisabled = await disableAutoApproveAfterCorrections(supabase, id, finalData, corrections);

    // The MemorySaver checkpoint only lives in this server process: close it if it is still paused.
    try {
      const snapshot = await compiledGraph.getState({ configurable: { thread_id: id } });
      if (snapshot?.next?.includes('approval')) await resumeApproval(compiledGraph, id, finalData);
    } catch (graphErr) {
      console.error(`[approve] Failed to close the pipeline checkpoint of invoice ${id}:`, graphErr);
    }

    return NextResponse.json({
      success: true,
      message: 'החשבונית אושרה',
      corrections: corrections.length,
      autoApproveDisabled,
    });
  } catch (err) {
    console.error(`Error approving invoice ${id}:`, err);
    return NextResponse.json({ error: 'שגיאה באישור החשבונית' }, { status: 500 });
  }
}
