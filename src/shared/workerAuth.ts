// Credentials of the scheduled processing worker (/api/invoices/worker). Pure, no Node APIs besides
// base64 (Buffer is available in the route runtime; atob as a fallback).

/** The configured secret without surrounding whitespace / quotes (a value pasted as "abc" or with a newline). */
export function normalizeWorkerSecret(value: string | null | undefined): string | null {
  if (!value) return null;
  let v = value.trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    v = v.slice(1, -1).trim();
  }
  return v || null;
}

function decodeBase64(value: string): string | null {
  try {
    if (typeof Buffer !== 'undefined') return Buffer.from(value, 'base64').toString('utf8');
    return atob(value);
  } catch {
    return null;
  }
}

/**
 * Every value a caller may have sent the secret as: `X-Ingest-Secret`, `X-Worker-Secret`,
 * `X-Api-Key` (EventBridge connection of type API key, any of these header names),
 * `Authorization: Bearer <secret>`, or Basic auth with the secret as password or user name.
 */
export function workerSecretCandidates(headers: { get(name: string): string | null }): string[] {
  const out: string[] = [];
  const add = (v: string | null | undefined) => {
    const n = normalizeWorkerSecret(v);
    if (n && !out.includes(n)) out.push(n);
  };
  add(headers.get('x-ingest-secret'));
  add(headers.get('x-worker-secret'));
  add(headers.get('x-api-key'));

  const auth = headers.get('authorization');
  if (auth) {
    const trimmed = auth.trim();
    const space = trimmed.indexOf(' ');
    const scheme = space === -1 ? '' : trimmed.slice(0, space).toLowerCase();
    const value = space === -1 ? trimmed : trimmed.slice(space + 1).trim();
    if (scheme === 'bearer') {
      add(value);
    } else if (scheme === 'basic') {
      const decoded = decodeBase64(value);
      if (decoded) {
        const colon = decoded.indexOf(':');
        if (colon === -1) add(decoded);
        else {
          add(decoded.slice(colon + 1));
          add(decoded.slice(0, colon));
        }
      }
    } else if (!scheme) {
      add(value); // a bare secret in Authorization
    }
  }
  return out;
}
