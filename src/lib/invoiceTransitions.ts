import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { InvoiceStatus } from '@/shared/types';
import { isMockMode } from '@/lib/supabaseConfig';

// Server helpers for status changes: atomic conditional updates (no lost races between two
// reviewers, or between a reviewer and an export), safe JSON body parsing and Hebrew DB errors.

export type JsonBodyResult<T> = { ok: true; body: T } | { ok: false; response: NextResponse };

/**
 * Reads a JSON object body. Malformed JSON, an empty body, `null`, arrays and primitives → 400 with
 * a Hebrew message (never the raw parser text). With `optional`, an empty body is `{}`.
 */
export async function readJsonObject<T extends Record<string, unknown> = Record<string, unknown>>(
  request: Request,
  options: { optional?: boolean } = {}
): Promise<JsonBodyResult<T>> {
  let text: string;
  try {
    text = await request.text();
  } catch (err) {
    console.error('[readJsonObject] Failed to read the request body:', err);
    return { ok: false, response: NextResponse.json({ error: 'לא ניתן לקרוא את גוף הבקשה' }, { status: 400 }) };
  }
  if (text.trim() === '' && options.optional) return { ok: true, body: {} as T };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, response: NextResponse.json({ error: 'גוף הבקשה אינו JSON תקין' }, { status: 400 }) };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, response: NextResponse.json({ error: 'גוף הבקשה חייב להיות אובייקט JSON' }, { status: 400 }) };
  }
  return { ok: true, body: parsed as T };
}

interface PgError {
  code?: string | null;
  message?: string | null;
}

/** Marker raised by the invoices_status_guard trigger (see the qa_status_integrity migration). */
const GUARD_MARKERS: Record<string, string> = {
  invoice_exported_final: 'החשבונית כבר יוצאה להנהלת החשבונות ולא ניתן לשנות את הסטטוס שלה (פתיחה מחדש - בעל המשרד בלבד)',
  invoice_status_api_only: 'שינוי סטטוס של חשבונית מתבצע דרך המערכת בלבד',
};

/** Maps a PostgREST / Postgres error to an HTTP status + Hebrew message (never the raw English text). */
export function dbErrorResponse(error: PgError, fallback = 'שגיאה בעדכון החשבונית'): NextResponse {
  const message = error.message ?? '';
  for (const [marker, hebrew] of Object.entries(GUARD_MARKERS)) {
    if (message.includes(marker)) return NextResponse.json({ error: hebrew }, { status: 409 });
  }
  switch (error.code) {
    case '23514': // check_violation (e.g. invoices_status_check)
      return NextResponse.json({ error: 'הערך אינו מותר עבור החשבונית (בדיקת תקינות במסד הנתונים)' }, { status: 409 });
    case '23505':
      return NextResponse.json({ error: 'הרשומה כבר קיימת' }, { status: 409 });
    case '23503':
      return NextResponse.json({ error: 'החשבונית מקושרת לרשומות אחרות ולא ניתן לבצע את הפעולה' }, { status: 409 });
    case '23502':
    case '22P02':
    case '22007':
    case '22008':
    case '22003':
    case 'PGRST204': // unknown column
    case '42703':
      return NextResponse.json({ error: 'נתוני העדכון אינם תקינים' }, { status: 400 });
    default:
      console.error('[invoiceTransitions] Unexpected DB error:', error);
      return NextResponse.json({ error: fallback }, { status: 500 });
  }
}

export type TransitionOutcome =
  | { ok: true }
  | { ok: false; reason: 'conflict'; currentStatus: InvoiceStatus | null }
  | { ok: false; reason: 'db'; error: PgError };

/**
 * Moves an invoice to `patch.status` only while its status is still one of `from` (one UPDATE …
 * WHERE id = … AND status IN (…)). A concurrent change makes it a 'conflict' instead of
 * overwriting, e.g. an export that ran while the reviewer still had the form open.
 */
export async function transitionInvoice(
  db: SupabaseClient,
  invoiceId: string,
  from: readonly InvoiceStatus[],
  patch: Record<string, unknown> & { status: InvoiceStatus }
): Promise<TransitionOutcome> {
  const now = new Date().toISOString();
  const { data, error } = await db
    .from('invoices')
    .update({ ...patch, updated_at: now })
    .eq('id', invoiceId)
    .in('status', [...from])
    .select('id');
  if (error) return { ok: false, reason: 'db', error };
  if (Array.isArray(data) && data.length > 0) return { ok: true };

  // No row matched: someone changed the status first. (The local mock DB re-applies the filters
  // after updating and stamps its own updated_at, so there a successful update also comes back
  // empty: only in mock mode, treat "now in the target status, just updated" as success.)
  const { data: current, error: readErr } = await db
    .from('invoices')
    .select('status, updated_at')
    .eq('id', invoiceId)
    .single();
  if (readErr || !current) return { ok: false, reason: 'conflict', currentStatus: null };
  const row = current as { status: InvoiceStatus; updated_at: string | null };
  if (
    isMockMode() &&
    row.status === patch.status &&
    row.updated_at &&
    Math.abs(Date.parse(row.updated_at) - Date.parse(now)) < 5000
  ) {
    return { ok: true };
  }
  return { ok: false, reason: 'conflict', currentStatus: row.status };
}
