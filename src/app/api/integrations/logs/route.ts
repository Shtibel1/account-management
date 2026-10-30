import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { isUuid, requireClientAccess } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/** List columns (bodies are only returned by the detail endpoint). */
const LOG_LIST_COLUMNS =
  'id, created_at, plugin_id, invoice_id, correlation_id, operation, http_method, url, response_status, duration_ms, attempt, outcome, error_code, error_message';

const OUTCOMES = new Set(['ok', 'error', 'retry']);

/**
 * Integration log of one client, newest first.
 * Query: clientId (required), pluginId?, outcome? (ok|error|retry), invoiceId?, correlationId?,
 * limit? (1-200, default 50), before? (ISO created_at cursor for the next page).
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const clientId = url.searchParams.get('clientId');
  const access = await requireClientAccess(clientId);
  if (!access.ok) return access.response;
  const mock = access.value.ctx.mock;

  const pluginId = url.searchParams.get('pluginId');
  const outcome = url.searchParams.get('outcome');
  const invoiceId = url.searchParams.get('invoiceId');
  const correlationId = url.searchParams.get('correlationId');
  const before = url.searchParams.get('before');
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));

  if (outcome && !OUTCOMES.has(outcome)) return NextResponse.json({ error: 'סינון לא תקין' }, { status: 400 });
  if (!mock && ((invoiceId && !isUuid(invoiceId)) || (correlationId && !isUuid(correlationId)))) {
    return NextResponse.json({ error: 'סינון לא תקין' }, { status: 400 });
  }
  if (before && Number.isNaN(Date.parse(before))) return NextResponse.json({ error: 'סינון לא תקין' }, { status: 400 });

  try {
    let query = supabase.from('integration_logs').select(LOG_LIST_COLUMNS).eq('client_id', access.value.clientId);
    if (pluginId) query = query.eq('plugin_id', pluginId);
    if (outcome) query = query.eq('outcome', outcome);
    if (invoiceId) query = query.eq('invoice_id', invoiceId);
    if (correlationId) query = query.eq('correlation_id', correlationId);
    if (before && !mock) query = query.lt('created_at', new Date(before).toISOString());
    const { data, error } = await query.order('created_at', { ascending: false }).limit(limit);
    if (error) throw new Error(error.message);
    const logs = data ?? [];
    return NextResponse.json({
      logs,
      nextBefore: logs.length === limit ? (logs[logs.length - 1] as { created_at: string }).created_at : null,
    });
  } catch (err) {
    console.error(`[Integration logs API] Failed to load logs for client ${clientId}:`, err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: 'שגיאה בטעינת היומן' }, { status: 500 });
  }
}
