/**
 * Tool input of a streamed model call that was cut at its time limit (QA round 3 review). The
 * stream's snapshot is parsed from incomplete JSON, so the value written last may itself be cut
 * ("total_amount": 12 of 1234.5, a supplier name missing its end): that last value is dropped, and
 * everything before it - complete by construction - is kept. In an array (line_items) only its last
 * element is dropped; in an object (field_confidence) its last key, recursively.
 */
export function trimPartialToolInput(input: unknown): Record<string, unknown> | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const trimmed = dropLast(input as Record<string, unknown>);
  return Object.keys(trimmed).length > 0 ? trimmed : null;
}

function dropLast(obj: Record<string, unknown>): Record<string, unknown> {
  const keys = Object.keys(obj);
  if (keys.length === 0) return {};
  const last = keys[keys.length - 1];
  const out: Record<string, unknown> = {};
  for (const key of keys.slice(0, -1)) out[key] = obj[key];
  const value = obj[last];
  if (Array.isArray(value)) {
    if (value.length > 1) out[last] = value.slice(0, -1);
  } else if (value && typeof value === 'object' && !('x1' in value)) {
    // (a cut bbox is dropped whole: one without all its corners is no bbox)
    const inner = dropLast(value as Record<string, unknown>);
    if (Object.keys(inner).length > 0) out[last] = inner;
  }
  return out;
}

/** Rough output-token count of streamed JSON when the call was aborted before its usage arrived. */
export function estimateOutputTokens(jsonChars: number): number {
  return Math.ceil(Math.max(0, jsonChars) / 3);
}
