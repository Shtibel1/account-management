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
    } else if (code <= 0xFF) {
      // Standard ASCII / Latin-1 characters
      bytes.push(code);
    } else {
      // Fallback for non-representable characters
      bytes.push(0x3F); // '?'
    }
  }
  return Buffer.from(bytes);
}
