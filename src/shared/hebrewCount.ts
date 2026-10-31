/** "חשבונית אחת" / "3 חשבוניות" (Hebrew: the singular takes "אחת" after the noun, not the digit 1). */
export function invoicesCountHe(n: number): string {
  return n === 1 ? 'חשבונית אחת' : `${n} חשבוניות`;
}

/** Toast after supplier rules were re-applied to invoices awaiting review. */
export function ruleReappliedMessage(updated: number, options: { plural?: boolean; others?: boolean } = {}): string {
  const subject = options.plural ? 'כללי הספק הוחלו' : 'כלל הספק הוחל';
  const one = updated === 1;
  const others = options.others ? (one ? ' נוספת' : ' נוספות') : '';
  const waiting = one ? 'הממתינה לבדיקה' : 'הממתינות לבדיקה';
  return `${subject} על ${invoicesCountHe(updated)}${others} ${waiting}`;
}
