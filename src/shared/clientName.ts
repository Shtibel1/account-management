// Client names inside one office (bookkeeping org) must be unique (QA round 8): two cards called
// "QA-דפדפן" could only be told apart in the review filter by their VAT code. Names are compared
// trimmed, case-insensitively and with internal whitespace collapsed. Checked by the server on create
// (POST /api/clients) and on rename (PATCH /api/clients/[id]); the forms show the 409 message inline.

export const DUPLICATE_CLIENT_NAME_MESSAGE = 'לקוח בשם זה כבר קיים במשרד';
export const CLIENT_NAME_REQUIRED_MESSAGE = 'יש להזין שם לקוח';
export const CLIENT_NAME_MAX_LENGTH = 200;

/** Display form of a typed name: trimmed, inner whitespace collapsed to single spaces. */
export function cleanClientName(value: unknown): string {
  return typeof value === 'string' ? value.normalize('NFC').replace(/\s+/g, ' ').trim() : '';
}

/** Comparison key: cleaned and lower-cased (Hebrew has no case; Latin letters do). */
export function normalizeClientName(value: unknown): string {
  return cleanClientName(value).toLocaleLowerCase('en-US');
}

/** Hebrew error for a typed client name, or null when it is usable. */
export function clientNameError(value: unknown): string | null {
  const name = cleanClientName(value);
  if (!name) return CLIENT_NAME_REQUIRED_MESSAGE;
  if (name.length > CLIENT_NAME_MAX_LENGTH) return `שם הלקוח ארוך מדי (עד ${CLIENT_NAME_MAX_LENGTH} תווים)`;
  return null;
}

/** The existing client (other than `excludeId`) whose name equals `name` after normalization. */
export function findDuplicateClientName<T extends { id: string; name: string | null }>(
  existing: readonly T[],
  name: string,
  excludeId?: string
): T | null {
  const key = normalizeClientName(name);
  if (!key) return null;
  return existing.find((c) => c.id !== excludeId && normalizeClientName(c.name) === key) ?? null;
}
