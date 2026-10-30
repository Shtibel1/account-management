/**
 * Abuse controls of the public lead form (POST /api/lead, QA #34). Pure helpers - the route wires
 * them to the DB counter (lead_rate_limit_hit, migration 20261030162000_qa_export_security.sql).
 *
 *   - honeypot: the form has a hidden "website" field people never fill; bots that fill every input
 *     get a fake success and no email is sent;
 *   - size caps on every field and on the whole body;
 *   - rate limits per client IP (hashed, never stored raw) and a global cap, counted in the DB so
 *     they hold across server instances; an in-memory counter is the fallback when the DB counter
 *     isn't available (migration not applied / local mock mode).
 */

export const LEAD_HONEYPOT_FIELD = 'website';

export const LEAD_LIMITS = {
  maxBodyBytes: 16 * 1024,
  name: 100,
  contact: 200,
  volume: 100,
  notes: 2000,
} as const;

export interface RateRule {
  /** Counter name prefix, e.g. "ip10m". */
  name: string;
  windowSeconds: number;
  max: number;
  /** true: one counter per IP; false: a single global counter. */
  perIp: boolean;
}

export const LEAD_RATE_RULES: RateRule[] = [
  { name: 'ip10m', windowSeconds: 10 * 60, max: 3, perIp: true },
  { name: 'ipday', windowSeconds: 24 * 60 * 60, max: 10, perIp: true },
  { name: 'global1h', windowSeconds: 60 * 60, max: 30, perIp: false },
];

export const LEAD_SCAN_TYPES = ['photos', 'documents', 'invoices'] as const;

export interface LeadInput {
  name: string;
  contact: string;
  scanTypes: string[];
  volume: string;
  notes: string;
}

export type LeadParse =
  | { ok: true; honeypot: boolean; lead: LeadInput }
  | { ok: false; error: string };

/** Validates and normalizes the form body (Hebrew errors). */
export function parseLead(body: unknown): LeadParse {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'בקשה לא תקינה' };
  const b = body as Record<string, unknown>;
  const honeypotValue = b[LEAD_HONEYPOT_FIELD];
  const honeypot = typeof honeypotValue === 'string' ? honeypotValue.trim().length > 0 : honeypotValue != null && honeypotValue !== false;

  const name = typeof b.name === 'string' ? b.name.trim() : '';
  const contact = typeof b.contact === 'string' ? b.contact.trim() : '';
  if (!name) return { ok: false, error: 'שם הוא שדה חובה' };
  if (!contact) return { ok: false, error: 'פרטי קשר הם שדה חובה' };
  if (name.length > LEAD_LIMITS.name) return { ok: false, error: `השם ארוך מדי (עד ${LEAD_LIMITS.name} תווים)` };
  if (contact.length > LEAD_LIMITS.contact) return { ok: false, error: `פרטי הקשר ארוכים מדי (עד ${LEAD_LIMITS.contact} תווים)` };

  const volume = typeof b.volume === 'string' ? b.volume.trim() : '';
  const notes = typeof b.notes === 'string' ? b.notes.trim() : '';
  if (volume.length > LEAD_LIMITS.volume) return { ok: false, error: `הכמות ארוכה מדי (עד ${LEAD_LIMITS.volume} תווים)` };
  if (notes.length > LEAD_LIMITS.notes) return { ok: false, error: `ההערות ארוכות מדי (עד ${LEAD_LIMITS.notes} תווים)` };

  const allowed = new Set<string>(LEAD_SCAN_TYPES);
  const scanTypes = Array.isArray(b.scanTypes)
    ? [...new Set(b.scanTypes.filter((t): t is string => typeof t === 'string' && allowed.has(t)))]
    : [];

  // Header-breaking characters never belong in the name (it goes into the email subject).
  const cleanName = name.replace(/[\r\n\t]+/g, ' ');
  return { ok: true, honeypot, lead: { name: cleanName, contact, scanTypes, volume, notes } };
}

const PRIVATE_IP = /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|f[cd][0-9a-f]{2}:|fe80:)/i;

function cleanIp(value: string): string {
  let v = value.trim();
  // "[2001:db8::1]:1234" / "1.2.3.4:5678"
  const bracket = /^\[([^\]]+)\](?::\d+)?$/.exec(v);
  if (bracket) v = bracket[1];
  else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(v)) v = v.split(':')[0];
  return v.toLowerCase();
}

interface HeaderReader {
  get(name: string): string | null;
}

/**
 * Best-effort client IP. CloudFront APPENDS the viewer address to X-Forwarded-For, so the left-most
 * entries are whatever the client sent: the right-most public address is the one our CDN saw.
 * CloudFront-Viewer-Address (when forwarded) is preferred.
 */
export function clientIpFrom(headers: HeaderReader): string {
  const viewer = headers.get('cloudfront-viewer-address');
  if (viewer) {
    // "<ip>:<port>" - IPv6 without brackets, so the port is after the LAST colon.
    const v = viewer.trim();
    const ip = cleanIp(v.lastIndexOf(':') > 0 ? v.slice(0, v.lastIndexOf(':')) : v);
    if (ip) return ip;
  }
  const chain = (headers.get('x-forwarded-for') ?? '')
    .split(',')
    .map(cleanIp)
    .filter(Boolean);
  for (let i = chain.length - 1; i >= 0; i--) {
    if (!PRIVATE_IP.test(chain[i])) return chain[i];
  }
  return chain[chain.length - 1] || headers.get('x-real-ip')?.trim() || 'unknown';
}

/** Counter bucket names for one request (the IP is already hashed by the caller). Per-IP buckets
 * come first: the DB check (lead_rate_limit_hit_all) stops at the first full bucket and counts
 * nothing, so a refused request never touches the global counter. */
export function rateBuckets(ipHash: string): { rule: RateRule; bucket: string }[] {
  return LEAD_RATE_RULES.map((rule) => ({ rule, bucket: rule.perIp ? `${rule.name}:${ipHash}` : rule.name }));
}

/** In-memory fixed-window counter (fallback; per server instance). */
export class MemoryRateLimiter {
  private counters = new Map<string, { windowStart: number; hits: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Counts one hit; true while the bucket is within `max` for the current window. */
  hit(bucket: string, windowSeconds: number, max: number): boolean {
    const windowMs = windowSeconds * 1000;
    const windowStart = Math.floor(this.now() / windowMs) * windowMs;
    const key = `${bucket}@${windowSeconds}`;
    const current = this.counters.get(key);
    const entry = current && current.windowStart === windowStart ? current : { windowStart, hits: 0 };
    entry.hits += 1;
    this.counters.set(key, entry);
    if (this.counters.size > 10_000) this.prune(windowStart);
    return entry.hits <= max;
  }

  /**
   * All-or-nothing: when every bucket still has room in its current window, counts one hit on each
   * and returns true; otherwise counts NOTHING and returns false (a request refused by the per-IP
   * limit must not use up the global budget meant for other visitors - QA round 2 N6).
   */
  hitAll(entries: { bucket: string; windowSeconds: number; max: number }[]): boolean {
    const now = this.now();
    const slots = entries.map(({ bucket, windowSeconds, max }) => {
      const windowMs = windowSeconds * 1000;
      const windowStart = Math.floor(now / windowMs) * windowMs;
      const key = `${bucket}@${windowSeconds}`;
      const current = this.counters.get(key);
      const entry = current && current.windowStart === windowStart ? current : { windowStart, hits: 0 };
      return { key, entry, max, windowStart };
    });
    if (slots.some((s) => s.entry.hits >= s.max)) return false;
    for (const s of slots) {
      s.entry.hits += 1;
      this.counters.set(s.key, s.entry);
    }
    if (this.counters.size > 10_000) this.prune(Math.min(...slots.map((s) => s.windowStart)));
    return true;
  }

  private prune(currentWindow: number): void {
    for (const [key, value] of this.counters) {
      if (value.windowStart < currentWindow - 24 * 60 * 60 * 1000) this.counters.delete(key);
    }
  }
}
