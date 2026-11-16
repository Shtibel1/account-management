/**
 * Hebrew counted nouns. In Hebrew the number one follows the noun and agrees with
 * its gender ("חשבונית אחת", "כלל אחד"), so "1 חשבוניות" is wrong; from 2 up the
 * digit precedes the plural noun ("3 חשבוניות").
 */

type Gender = 'm' | 'f';

interface Noun {
  one: string;
  many: string;
  gender: Gender;
}

export const HE_NOUNS = {
  invoice: { one: 'חשבונית', many: 'חשבוניות', gender: 'f' },
  client: { one: 'לקוח', many: 'לקוחות', gender: 'm' },
  transaction: { one: 'תנועה', many: 'תנועות', gender: 'f' },
  rule: { one: 'כלל', many: 'כללים', gender: 'm' },
  document: { one: 'מסמך', many: 'מסמכים', gender: 'm' },
  file: { one: 'קובץ', many: 'קבצים', gender: 'm' },
  row: { one: 'שורה', many: 'שורות', gender: 'f' },
  supplier: { one: 'ספק', many: 'ספקים', gender: 'm' },
  page: { one: 'עמוד', many: 'עמודים', gender: 'm' },
  field: { one: 'שדה', many: 'שדות', gender: 'm' },
} as const satisfies Record<string, Noun>;

export type HeNoun = keyof typeof HE_NOUNS;

/** An adjective that follows the noun, in singular and plural form ("פעיל" / "פעילים"). */
export interface HeAdjective {
  one: string;
  many: string;
}

/**
 * "חשבונית אחת" / "3 חשבוניות"; with an adjective: "לקוח פעיל אחד" / "3 לקוחות פעילים".
 * Zero and negative counts use the plural with the digit ("0 חשבוניות").
 */
export function countHe(n: number, noun: HeNoun, adjective?: HeAdjective): string {
  const { one, many, gender } = HE_NOUNS[noun] as Noun;
  if (n === 1) {
    return `${one}${adjective ? ` ${adjective.one}` : ''} ${gender === 'f' ? 'אחת' : 'אחד'}`;
  }
  return `${n} ${many}${adjective ? ` ${adjective.many}` : ''}`;
}

/** Picks the singular or plural form of a word that agrees with a count (verbs, adjectives). */
export function byCountHe(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** "חשבונית אחת" / "3 חשבוניות" (Hebrew: the singular takes "אחת" after the noun, not the digit 1). */
export function invoicesCountHe(n: number): string {
  return countHe(n, 'invoice');
}

/** Toast after supplier rules were re-applied to invoices awaiting review. */
export function ruleReappliedMessage(updated: number, options: { plural?: boolean; others?: boolean } = {}): string {
  const subject = options.plural ? 'כללי הספק הוחלו' : 'כלל הספק הוחל';
  const one = updated === 1;
  const others = options.others ? (one ? ' נוספת' : ' נוספות') : '';
  const waiting = one ? 'הממתינה לבדיקה' : 'הממתינות לבדיקה';
  return `${subject} על ${invoicesCountHe(updated)}${others} ${waiting}`;
}
