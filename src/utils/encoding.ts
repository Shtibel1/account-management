/**
 * Visual Hebrew conversion for RTL displays.
 * Reverses RTL characters but keeps numeric and English runs LTR.
 */
export function toVisualHebrew(str: string | null | undefined): string {
  if (!str) return '';
  // Reverse the entire string character-by-character
  const reversed = str.split('').reverse().join('');
  // Find contiguous digit sequences and reverse them back to LTR order
  return reversed.replace(/\d+/g, (match) => match.split('').reverse().join(''));
}

/** Non-ASCII characters outside א-ת that exist in Windows-1255. */
const WINDOWS_1255_EXTRA: Record<number, number> = {
  0x00a0: 0xa0, // no-break space
  0x20aa: 0xa4, // ₪
  0x2013: 0x96, // – en dash
  0x2014: 0x97, // — em dash
  0x2018: 0x91, // ‘
  0x2019: 0x92, // ’
  0x201c: 0x93, // “
  0x201d: 0x94, // ”
  0x00d7: 0xaa, // ×
  0x00f7: 0xba, // ÷
};

/**
 * Encodes a string into Windows-1255 (Hebrew single-byte encoding) bytes.
 */
export function encodeWindows1255(str: string): Buffer {
  const bytes: number[] = [];
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code >= 0x05D0 && code <= 0x05EA) {
      // Hebrew characters א to ת map to 0xE0 to 0xFA in Windows-1255
      bytes.push(code - 0x05D0 + 0xE0);
    } else if (code === 0x05F4) { // Gershayim ״
      bytes.push(0x22); // Map to standard double quote "
    } else if (code === 0x05F3) { // Geresh ׳
      bytes.push(0x27); // Map to standard single quote '
    } else if (code <= 0x7F) {
      // ASCII is identical in Windows-1255
      bytes.push(code);
    } else if (WINDOWS_1255_EXTRA[code] !== undefined) {
      bytes.push(WINDOWS_1255_EXTRA[code]);
    } else {
      // Latin-1 (0x80-0xFF) is NOT passed through: in Windows-1255 0xE0-0xFA are Hebrew letters,
      // so e.g. "é" would have become a "ש". Non-representable characters become '?'.
      bytes.push(0x3F); // '?'
    }
  }
  return Buffer.from(bytes);
}
