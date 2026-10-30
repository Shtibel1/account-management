/**
 * Visual-order text for the Move-in file (an RTL field read left-to-right byte by byte).
 *
 * A simplified Unicode bidi pass for an RTL paragraph:
 *  - strong LTR: Latin letters and digits (digits are kept as one number, e.g. "12.50", "05-1234");
 *  - strong RTL: Hebrew (and other RTL scripts);
 *  - neutrals (spaces, punctuation): LTR when they sit BETWEEN two LTR characters (so "IKEA Ltd" or
 *    "12.50" stay one run), otherwise RTL (the paragraph direction).
 * The visual line is the runs in reverse order; RTL runs are reversed character by character (with
 * paired brackets mirrored), LTR runs keep their logical order. So "QA-ספק" becomes "קפס-QA" and
 * "IKEA ישראל" becomes "לארשי IKEA" - Latin / numbers are never written backwards (QA N7).
 */
export function toVisualHebrew(str: string | null | undefined): string {
  if (!str) return '';
  const chars = Array.from(str);
  const kinds = chars.map(bidiKind);
  // Resolve neutrals: LTR only when the nearest strong characters on both sides are LTR.
  const resolved: ('L' | 'R')[] = new Array(chars.length);
  for (let i = 0; i < chars.length; i++) {
    const k = kinds[i];
    if (k !== 'N') {
      resolved[i] = k;
      continue;
    }
    let j = i;
    while (j < chars.length && kinds[j] === 'N') j++;
    const before = i > 0 ? resolved[i - 1] : 'R';
    const after = j < chars.length ? kinds[j] : 'R';
    const dir: 'L' | 'R' = before === 'L' && after === 'L' ? 'L' : 'R';
    for (let n = i; n < j; n++) resolved[n] = dir;
    i = j - 1;
  }

  // Group into runs, then lay them out right-to-left.
  const runs: { dir: 'L' | 'R'; text: string[] }[] = [];
  for (let i = 0; i < chars.length; i++) {
    const last = runs[runs.length - 1];
    if (last && last.dir === resolved[i]) last.text.push(chars[i]);
    else runs.push({ dir: resolved[i], text: [chars[i]] });
  }
  return runs
    .reverse()
    .map((run) => (run.dir === 'L' ? run.text.join('') : run.text.reverse().map(mirror).join('')))
    .join('');
}

const MIRRORED: Record<string, string> = { '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{', '<': '>', '>': '<' };

function mirror(ch: string): string {
  return MIRRORED[ch] ?? ch;
}

function bidiKind(ch: string): 'L' | 'R' | 'N' {
  const code = ch.codePointAt(0) ?? 0;
  // Hebrew, Arabic, Syriac, Thaana, NKo ... and the Hebrew / Arabic presentation forms.
  if ((code >= 0x0590 && code <= 0x08ff) || (code >= 0xfb1d && code <= 0xfdff) || (code >= 0xfe70 && code <= 0xfeff)) return 'R';
  if (/[0-9]/.test(ch)) return 'L';
  if (/\p{L}/u.test(ch)) return 'L';
  return 'N';
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
