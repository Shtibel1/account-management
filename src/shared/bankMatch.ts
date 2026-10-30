// Bank statement <-> invoice matching (Dext Bank Match style). Pure: callers load the rows and
// persist the result (src/lib/bankTransactions.ts).
import type { BankMatchStatus, Invoice, MatchableInvoice } from '@/shared/types';

/** Amount difference (ILS) still treated as the same payment - rounding, agorot dropped by the bank. */
export const AMOUNT_TOLERANCE = 0.5;
/** A charge may precede the invoice by a few days (card charged, invoice issued on delivery)... */
export const DAYS_BEFORE_INVOICE = 7;
/** ...and is usually paid within net-60/90 terms after it. */
export const DAYS_AFTER_INVOICE = 90;
/** Two candidates with equal name evidence closer than this (in days from the charge) are ambiguous. */
export const DATE_MARGIN_DAYS = 7;
/** How many alternatives to keep for an ambiguous line (shown first in the manual picker). */
export const MAX_CANDIDATES = 5;

/**
 * Notice for an auto-match run that left invoices out (MatchRunResult.truncated): the rest was
 * matched, those invoices have too many open lines that could be them.
 */
export function bankMatchSkippedNote(skippedInvoices: number | undefined): string {
  const who =
    skippedInvoices === 1
      ? 'חשבונית אחת לא הותאמה אוטומטית כי יש לה'
      : skippedInvoices && skippedInvoices > 1
        ? `${skippedInvoices} חשבוניות לא הותאמו אוטומטית כי יש להן`
        : 'חלק מהחשבוניות לא הותאמו אוטומטית כי יש להן';
  return `${who} יותר מדי תנועות פתוחות שעשויות להתאים. יש להתאים אותן ידנית במסך הבנק.`;
}

export interface MatchableTransaction {
  id: string;
  txn_date: string;               // YYYY-MM-DD
  description: string;
  amount: number;                 // negative = debit
  match_status: BankMatchStatus;
  matched_invoice_id: string | null;
  rejected_invoice_ids?: string[] | null;
  /**
   * Its candidate list is known to be incomplete (it's also a candidate of an invoice left out of
   * the run): it still competes for the invoices it can see, but is never matched itself.
   */
  blocked?: boolean;
}

/** 0 = supplier name not in the description, 1 = some of it, 2 = most/all of it. */
export type NameLevel = 0 | 1 | 2;

export interface MatchCandidate {
  invoiceId: string;
  dayOffset: number;              // charge date minus invoice date (days)
  amountDiff: number;             // |charge| - invoice total, absolute
  nameLevel: NameLevel;
}

export interface AutoMatch {
  transactionId: string;
  invoiceId: string;
  candidate: MatchCandidate;
}

export interface AutoMatchResult {
  matches: AutoMatch[];
  /** Unmatched debits with more than one plausible invoice, best first. */
  ambiguous: Record<string, string[]>;
}

/** Invoice row -> the fields matching needs, preferring the reviewer-approved data. */
export function toMatchableInvoice(
  invoice: Pick<Invoice, 'id' | 'file_name' | 'status' | 'validated_data' | 'extracted_data'>
): MatchableInvoice {
  const data = invoice.validated_data ?? invoice.extracted_data;
  return {
    id: invoice.id,
    file_name: invoice.file_name,
    status: invoice.status,
    supplier_name: data?.supplier_name ?? null,
    invoice_number: data?.invoice_number ?? null,
    invoice_date: data?.invoice_date ?? null,
    total_amount: typeof data?.total_amount === 'number' ? data.total_amount : null,
  };
}

// Legal-entity suffixes and filler words that say nothing about who the supplier is.
const NAME_STOPWORDS = new Set([
  'בעמ', 'בע', 'מ', 'חברה', 'חברת', 'של', 'ltd', 'inc', 'llc', 'limited', 'co', 'corp', 'the', 'and',
  'ישראל', 'israel', 'שותפות', 'עמותה', 'סניף',
]);

/** Lowercase words without punctuation/quotes ("סופר-פארם (ישראל) בע"מ" -> סופר, פארם, ישראל, בעמ). */
function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[‎‏‪-‮]/g, '')
    .replace(/["'״׳`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter(Boolean);
}

/** Supplier name words that identify the supplier (at least 2 letters, no legal suffixes). */
export function supplierTokens(name: string | null | undefined): string[] {
  if (!name) return [];
  return [...new Set(words(name).filter((w) => w.length >= 2 && !NAME_STOPWORDS.has(w)))];
}

/** How strongly the bank description points at the supplier. */
export function nameLevel(supplierName: string | null | undefined, description: string): NameLevel {
  const tokens = supplierTokens(supplierName);
  if (tokens.length === 0) return 0;
  const descWords = words(description);
  if (descWords.length === 0) return 0;

  // Card descriptions often glue words ("SUPERPHARM", "סופרפארם") or truncate them.
  const glued = tokens.join('');
  const descGlued = descWords.join('');
  if (glued.length >= 4 && descGlued.includes(glued)) return 2;

  const hits = tokens.filter((t) =>
    descWords.some((w) => w === t || (t.length >= 4 && w.includes(t)) || (w.length >= 4 && t.startsWith(w)))
  ).length;
  if (hits === 0) return 0;
  return hits / tokens.length >= 0.5 ? 2 : 1;
}

function dayNumber(isoDate: string): number | null {
  const m = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return Math.round(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86_400_000);
}

/** Better candidate first: stronger name evidence, then closer date, then smaller amount difference. */
export function compareCandidates(a: MatchCandidate, b: MatchCandidate): number {
  if (a.nameLevel !== b.nameLevel) return b.nameLevel - a.nameLevel;
  const dist = Math.abs(a.dayOffset) - Math.abs(b.dayOffset);
  if (dist !== 0) return dist;
  return a.amountDiff - b.amountDiff;
}

/** True when `best` wins over `other` by enough that a human wouldn't hesitate. */
export function isClearlyBetter(best: MatchCandidate, other: MatchCandidate): boolean {
  if (best.nameLevel !== other.nameLevel) return best.nameLevel > other.nameLevel;
  return Math.abs(other.dayOffset) - Math.abs(best.dayOffset) >= DATE_MARGIN_DAYS;
}

/** Only unmatched debits are matched; credits (refunds, income) don't need a supplier invoice. */
export function isMatchableDebit(txn: Pick<MatchableTransaction, 'amount' | 'match_status'>): boolean {
  return txn.match_status === 'unmatched' && txn.amount < 0;
}

/** Candidate for one (transaction, invoice) pair, or null when amount/date rule it out. */
export function evaluateCandidate(txn: MatchableTransaction, invoice: MatchableInvoice): MatchCandidate | null {
  if (invoice.total_amount == null || invoice.total_amount <= 0 || !invoice.invoice_date) return null;
  const amountDiff = Math.round(Math.abs(Math.abs(txn.amount) - invoice.total_amount) * 100) / 100;
  if (amountDiff > AMOUNT_TOLERANCE) return null;

  const txnDay = dayNumber(txn.txn_date);
  const invoiceDay = dayNumber(invoice.invoice_date);
  if (txnDay == null || invoiceDay == null) return null;
  const dayOffset = txnDay - invoiceDay;
  if (dayOffset < -DAYS_BEFORE_INVOICE || dayOffset > DAYS_AFTER_INVOICE) return null;

  return { invoiceId: invoice.id, dayOffset, amountDiff, nameLevel: nameLevel(invoice.supplier_name, txn.description) };
}

/** Buckets invoices by whole shekel so candidate lookup doesn't scan every invoice per line. */
function indexByAmount(invoices: MatchableInvoice[]): Map<number, MatchableInvoice[]> {
  const index = new Map<number, MatchableInvoice[]>();
  for (const inv of invoices) {
    if (inv.total_amount == null) continue;
    const bucket = Math.round(inv.total_amount);
    const list = index.get(bucket);
    if (list) list.push(inv);
    else index.set(bucket, [inv]);
  }
  return index;
}

function candidatesFrom(
  txn: MatchableTransaction,
  index: Map<number, MatchableInvoice[]>,
  excluded: Set<string>
): MatchCandidate[] {
  const rejected = new Set(txn.rejected_invoice_ids ?? []);
  const bucket = Math.round(Math.abs(txn.amount));
  const result: MatchCandidate[] = [];
  for (const b of [bucket - 1, bucket, bucket + 1]) {
    for (const inv of index.get(b) ?? []) {
      if (excluded.has(inv.id) || rejected.has(inv.id)) continue;
      const c = evaluateCandidate(txn, inv);
      if (c) result.push(c);
    }
  }
  return result.sort(compareCandidates);
}

/** Invoices already paired with a statement line (auto or manual) - never offered again. */
export function usedInvoiceIds(transactions: MatchableTransaction[]): Set<string> {
  return new Set(
    transactions
      .filter((t) => (t.match_status === 'auto' || t.match_status === 'manual') && t.matched_invoice_id)
      .map((t) => t.matched_invoice_id as string)
  );
}

/** Ranked candidate invoices for one line (manual picker / "why wasn't this matched"). */
export function findCandidates(
  txn: MatchableTransaction,
  invoices: MatchableInvoice[],
  usedIds: Set<string> = new Set()
): MatchCandidate[] {
  return candidatesFrom(txn, indexByAmount(invoices), usedIds);
}

/**
 * Pairs unmatched debits with invoices. A pair is accepted only when the invoice is the line's clear
 * favourite AND the line is the invoice's clear favourite among all competing lines, so one invoice
 * is never matched twice and ties stay for a human. Accepting a pair can resolve other lines (their
 * rival candidate is gone), so it repeats until nothing changes. A `blocked` line is a rival but is
 * never accepted (its own favourite can't be checked).
 */
export function autoMatch(transactions: MatchableTransaction[], invoices: MatchableInvoice[]): AutoMatchResult {
  const index = indexByAmount(invoices);
  const used = usedInvoiceIds(transactions);
  let pending = transactions.filter(isMatchableDebit);
  const matches: AutoMatch[] = [];

  for (;;) {
    const candidates = new Map<string, MatchCandidate[]>();
    // invoice id -> every pending line that could be it
    const contenders = new Map<string, { txnId: string; candidate: MatchCandidate }[]>();
    for (const txn of pending) {
      const list = candidatesFrom(txn, index, used);
      candidates.set(txn.id, list);
      for (const c of list) {
        const entry = contenders.get(c.invoiceId);
        if (entry) entry.push({ txnId: txn.id, candidate: c });
        else contenders.set(c.invoiceId, [{ txnId: txn.id, candidate: c }]);
      }
    }

    const accepted: AutoMatch[] = [];
    for (const txn of pending) {
      if (txn.blocked) continue;
      const list = candidates.get(txn.id) ?? [];
      if (list.length === 0) continue;
      const best = list[0];
      if (list.length > 1 && !isClearlyBetter(best, list[1])) continue;
      const rivals = (contenders.get(best.invoiceId) ?? []).filter((r) => r.txnId !== txn.id);
      if (rivals.some((r) => !isClearlyBetter(best, r.candidate))) continue;
      accepted.push({ transactionId: txn.id, invoiceId: best.invoiceId, candidate: best });
    }

    if (accepted.length === 0) {
      const ambiguous: Record<string, string[]> = {};
      for (const txn of pending) {
        const list = candidates.get(txn.id) ?? [];
        if (list.length > 0) ambiguous[txn.id] = list.slice(0, MAX_CANDIDATES).map((c) => c.invoiceId);
      }
      return { matches, ambiguous };
    }

    for (const m of accepted) {
      matches.push(m);
      used.add(m.invoiceId);
    }
    const done = new Set(accepted.map((m) => m.transactionId));
    pending = pending.filter((t) => !done.has(t.id));
  }
}
