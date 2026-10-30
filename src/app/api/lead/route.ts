import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { escapeHtml, sendEmail } from '@/lib/email';
import { supabase } from '@/lib/supabase';
import { clientIpFrom, LEAD_LIMITS, MemoryRateLimiter, parseLead, rateBuckets } from '@/lib/leadGuard';

const CONTACT_TO = process.env.CONTACT_TO_EMAIL || process.env.CONTACT_TO || process.env.CONTACT_EMAIL || 'nadavshtibel@gmail.com';
const CONTACT_FROM = process.env.CONTACT_FROM_EMAIL || process.env.CONTACT_FROM || 'contact@nadav-shtibel.com';

interface LeadData {
  name: string;
  contact: string;
  scanTypes: string[];
  volume: string;
  notes: string;
}

function formatLeadEmail(data: LeadData): { subject: string; textBody: string; htmlBody: string } {
  const scanTypesMap: Record<string, string> = {
    photos: 'תמונות ואלבומים',
    documents: 'מסמכים',
    invoices: 'חשבוניות וקבלות',
  };

  const scanTypesText = data.scanTypes.length > 0
    ? data.scanTypes.map(t => scanTypesMap[t] || t).join(', ')
    : 'לא צוין';

  const subject = `[סריקה בעברית] פנייה חדשה מ-${data.name}`;

  const textBody = `
פנייה חדשה מאתר סריקה בעברית
================================

שם: ${data.name}
פרטי קשר: ${data.contact}
סוג סריקה: ${scanTypesText}
כמות משוערת: ${data.volume || 'לא צוין'}
הערות: ${data.notes || 'אין'}

---
הודעה זו נשלחה אוטומטית מטופס ההזמנה באתר.
  `.trim();

  const htmlBody = `
<!DOCTYPE html>
<html dir="rtl" lang="he">
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: 'Heebo', Arial, sans-serif; line-height: 1.6; color: #1c1917; background: #f5f5f4; margin: 0; padding: 20px; }
    .container { max-width: 600px; margin: 0 auto; background: white; border-radius: 12px; padding: 32px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    h1 { color: #2563eb; margin-top: 0; font-size: 24px; }
    .field { margin-bottom: 16px; }
    .label { font-weight: 600; color: #57534e; font-size: 14px; }
    .value { margin-top: 4px; }
    .divider { border-top: 1px solid #e7e5e4; margin: 24px 0; }
    .footer { color: #a8a29e; font-size: 12px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>פנייה חדשה מאתר סריקה בעברית</h1>
    
    <div class="field">
      <div class="label">שם</div>
      <div class="value">${escapeHtml(data.name)}</div>
    </div>
    
    <div class="field">
      <div class="label">פרטי קשר</div>
      <div class="value">${escapeHtml(data.contact)}</div>
    </div>
    
    <div class="field">
      <div class="label">סוג סריקה</div>
      <div class="value">${escapeHtml(scanTypesText)}</div>
    </div>
    
    <div class="field">
      <div class="label">כמות משוערת</div>
      <div class="value">${escapeHtml(data.volume || 'לא צוין')}</div>
    </div>
    
    <div class="field">
      <div class="label">הערות</div>
      <div class="value">${escapeHtml(data.notes || 'אין')}</div>
    </div>
    
    <div class="divider"></div>
    <div class="footer">הודעה זו נשלחה אוטומטית מטופס ההזמנה באתר.</div>
  </div>
</body>
</html>
  `.trim();

  return { subject, textBody, htmlBody };
}

async function sendViaSES(data: LeadData): Promise<void> {
  const { subject, textBody, htmlBody } = formatLeadEmail(data);
  await sendEmail({ from: CONTACT_FROM, to: [CONTACT_TO], subject, textBody, htmlBody });
}

const memoryLimiter = new MemoryRateLimiter();

/** Per-bucket DB counters (lead_rate_limit_hit), short-circuiting on the first full bucket; null when unavailable. */
async function withinLegacyDbRateLimits(entries: { bucket: string; windowSeconds: number; max: number }[]): Promise<boolean | null> {
  for (const e of entries) {
    const { data, error } = await supabase.rpc('lead_rate_limit_hit', {
      p_bucket: e.bucket,
      p_window_seconds: e.windowSeconds,
      p_max: e.max,
    });
    if (error || typeof data !== 'boolean') {
      console.warn('[Lead] DB rate limit unavailable, using the in-memory limiter:', error?.message ?? 'no result');
      return null;
    }
    if (!data) return false;
  }
  return true;
}

/**
 * Rate limits of this request, all-or-nothing: true = within every limit (one hit counted on each
 * bucket); false = some bucket is full and NOTHING was counted, so requests refused by the per-IP
 * limit don't use up the global budget (QA round 2 N6). Counted atomically in the DB
 * (lead_rate_limit_hit_all, migration 20261030182000_qa2_security2.sql) so it holds across server
 * instances; the in-memory limiter (same semantics) is the fallback when the DB counter is missing.
 */
async function withinRateLimits(request: NextRequest): Promise<boolean> {
  const salt = process.env.LEAD_RATE_SALT || process.env.SUPABASE_SERVICE_KEY || 'lead';
  const ipHash = createHash('sha256').update(`${salt}:${clientIpFrom(request.headers)}`).digest('hex').slice(0, 32);
  const entries = rateBuckets(ipHash).map(({ rule, bucket }) => ({ bucket, windowSeconds: rule.windowSeconds, max: rule.max }));
  try {
    const db = supabase as unknown as { rpc?: SupabaseClient['rpc'] };
    if (typeof db.rpc === 'function') {
      const { data, error } = await supabase.rpc('lead_rate_limit_hit_all', {
        p_buckets: entries.map((e) => ({ bucket: e.bucket, window_seconds: e.windowSeconds, max: e.max })),
      });
      if (!error && typeof data === 'boolean') return data;
      const missing = !!error && (error.code === 'PGRST202' || error.code === '42883');
      if (missing) {
        // lead_rate_limit_hit_all not deployed yet: keep the cross-instance DB counters with the
        // older per-bucket function, stopping at the first full bucket. Per-IP buckets come first,
        // so a request refused by its IP limit never counts toward the global bucket.
        const legacy = await withinLegacyDbRateLimits(entries);
        if (legacy !== null) return legacy;
      } else if (error) {
        console.warn('[Lead] DB rate limit unavailable, using the in-memory limiter:', error.message);
      }
    }
  } catch (err) {
    console.warn('[Lead] DB rate limit failed, using the in-memory limiter:', err instanceof Error ? err.message : String(err));
  }
  return memoryLimiter.hitAll(entries);
}

export async function POST(request: NextRequest) {
  try {
    const declaredLength = Number(request.headers.get('content-length') ?? '0');
    if (declaredLength > LEAD_LIMITS.maxBodyBytes) {
      return NextResponse.json({ error: 'הפנייה ארוכה מדי' }, { status: 413 });
    }
    const raw = await request.text();
    if (raw.length > LEAD_LIMITS.maxBodyBytes) {
      return NextResponse.json({ error: 'הפנייה ארוכה מדי' }, { status: 413 });
    }
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return NextResponse.json({ error: 'בקשה לא תקינה' }, { status: 400 });
    }

    const parsed = parseLead(body);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }

    // Honeypot filled (a bot): answer like a success, send nothing - and count nothing, so bot
    // traffic can't fill the shared rate-limit buckets of real visitors.
    if (parsed.honeypot) {
      console.warn('[Lead] Honeypot field filled - ignoring the submission.');
      return NextResponse.json({ success: true });
    }

    if (!(await withinRateLimits(request))) {
      return NextResponse.json(
        { error: 'נשלחו יותר מדי פניות. נסו שוב מאוחר יותר או פנו אלינו ישירות.' },
        { status: 429, headers: { 'Retry-After': '600' } }
      );
    }

    const leadData: LeadData = parsed.lead;

    await sendViaSES(leadData);
    console.log(`[Lead] Sent via SES to ${CONTACT_TO}: ${leadData.name}`);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[Lead] Error processing lead:', error);
    return NextResponse.json(
      { error: 'שגיאה בשליחת הפנייה. נסו שוב או פנו אלינו ישירות.' },
      { status: 500 }
    );
  }
}
