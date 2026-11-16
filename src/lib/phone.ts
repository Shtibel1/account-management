/** Phone helpers shared by the WhatsApp webhook and the clients page (browser-safe). */

/**
 * Normalizes a phone number to E.164 ("+972501234567").
 * Accepts Twilio's "whatsapp:+972..." form, Israeli local numbers ("050-123-4567"),
 * "972..." / "00972..." prefixes and common separators. Returns null when it can't be a phone.
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.trim().replace(/^whatsapp:/i, '').replace(/[\s\-().‎‏]/g, '');
  if (!s) return null;

  if (s.startsWith('+')) {
    s = s.substring(1);
  } else if (s.startsWith('00')) {
    s = s.substring(2);
  } else if (s.startsWith('0')) {
    // Israeli local format: 0XX... → 972XX...
    s = `972${s.substring(1)}`;
  }

  if (!/^\d+$/.test(s)) return null;
  if (s.startsWith('9720')) s = `972${s.substring(4)}`; // "+972 050..." typo
  if (s.length < 8 || s.length > 15) return null;
  if (s.startsWith('972') && (s.length < 11 || s.length > 12)) return null; // IL: 8-9 digit national number
  return `+${s}`;
}

/** Human-friendly display of an E.164 Israeli number ("050-123-4567"); other numbers unchanged. */
export function formatPhoneForDisplay(e164: string): string {
  const m = /^\+972(5\d)(\d{3})(\d{4})$/.exec(e164);
  if (m) return `0${m[1]}-${m[2]}-${m[3]}`;
  return e164;
}
