// Matching a supplier name against registrar records (data.gov.il companies / partnerships /
// non-profits). The registrar search is full-text, so a vague query ("חברה", "שירותים", "דלק")
// returns many unrelated businesses; autofilling the first one's number as the supplier's VAT ID
// is wrong. Only a specific name is looked up, and a record must match it as a whole.
import { isGenericSupplierName } from '@/shared/supplierRules';

/** Legal-form suffixes and punctuation that don't identify a business. */
const NOISE = /(?<![א-ת])(?:בע.?מ|ע.?ר)(?![א-ת])|["'׳״()~,.\-\/]|למיקוד|בפירוק|\bltd\b|l\.t\.d\.?|שותפות|מוגבלת|\binc\b|\bco\b/gi;

/**
 * Words that say what kind of business it is, not which one. A name made only of these (plus
 * legal suffixes) is not specific enough to look up.
 */
const GENERIC_WORDS = new Set([
  'חברה', 'חברת', 'החברה', 'שירותים', 'שירות', 'מסעדה', 'מסעדת', 'דלק', 'ספק', 'ספקים', 'שונים', 'כללי', 'כלליים',
  'חנות', 'מכולת', 'סופר', 'מרכול', 'קבלן', 'קבלנות', 'משרד', 'משרדי', 'תחנה', 'תחנת', 'מוסך', 'בית', 'קפה', 'מאפייה',
  'ישראל', 'בעמ', 'בע', 'מ', 'עמ', 'עוסק', 'מורשה', 'פטור', 'מסחר', 'יבוא', 'שיווק', 'הפצה', 'תעשיות', 'אחזקות',
  'השקעות', 'פרויקטים', 'ניהול', 'הנדסה', 'בניה', 'בנייה', 'נכסים', 'טכנולוגיות', 'מערכות', 'קבוצת', 'קבוצה',
  'company', 'services', 'service', 'group', 'holdings', 'trading', 'the',
]);

/** Name reduced to comparable words (legal suffixes and punctuation removed, lower case). */
export function cleanBusinessName(name: string): string {
  return name.replace(NOISE, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

function words(cleaned: string): string[] {
  return cleaned.split(' ').filter((w) => w.length >= 2);
}

/**
 * True when the name is specific enough for a registrar lookup: not a placeholder ("ספקים שונים"),
 * and it has at least one distinctive word (not a generic business word like "חברה" or "דלק").
 */
export function isSpecificSupplierName(name: string | null | undefined): boolean {
  if (!name || name.trim().length < 2 || isGenericSupplierName(name)) return false;
  const w = words(cleanBusinessName(name));
  return w.length > 0 && w.some((word) => !GENERIC_WORDS.has(word));
}

/**
 * True when a registrar record's name is the queried business:
 * - one distinctive word ("בזק"): the record name must be that word alone (after legal suffixes);
 * - several words: the record contains the whole query, or the query contains a multi-word record
 *   name, or at least two distinctive words and 60% of the shorter name's words are shared.
 */
export function registrarNameMatches(query: string, recordName: string): boolean {
  if (!isSpecificSupplierName(query)) return false;
  const q = cleanBusinessName(query);
  const c = cleanBusinessName(recordName);
  if (!q || !c) return false;
  if (q === c) return true;

  const wq = words(q);
  const wc = words(c);
  if (wq.length < 2) return false; // a single word only matches a record of exactly that name

  if (c.includes(q)) return true;
  if (wc.length >= 2 && q.includes(c) && wc.some((w) => !GENERIC_WORDS.has(w))) return true;

  const shared = wq.filter((w) => wc.includes(w));
  const distinctiveShared = shared.filter((w) => !GENERIC_WORDS.has(w));
  if (distinctiveShared.length >= 2 && shared.length / Math.min(wq.length, wc.length) >= 0.6) return true;

  return false;
}

export interface RegistrarRecord {
  name: unknown;
  number: unknown;
}

/**
 * The registrar number for the queried business, or null. A record named exactly like the query
 * (after legal suffixes) wins; otherwise every matching record must be the same business (one
 * number). A multi-word query such as "שירותי ניקיון" can match several unrelated companies whose
 * names contain it; taking the first would autofill an unrelated company's number.
 */
export function pickRegistrarMatch(query: string, records: readonly RegistrarRecord[]): string | null {
  if (!isSpecificSupplierName(query)) return null;
  const q = cleanBusinessName(query);
  const matches: { name: string; number: string }[] = [];
  for (const rec of records) {
    const name = typeof rec.name === 'string' ? rec.name : '';
    const number = rec.number == null ? '' : String(rec.number).trim();
    if (!name || !/^\d{5,9}$/.test(number)) continue;
    if (registrarNameMatches(query, name)) matches.push({ name, number });
  }
  if (matches.length === 0) return null;
  const exact = [...new Set(matches.filter((m) => cleanBusinessName(m.name) === q).map((m) => m.number))];
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  const numbers = [...new Set(matches.map((m) => m.number))];
  return numbers.length === 1 ? numbers[0] : null;
}
