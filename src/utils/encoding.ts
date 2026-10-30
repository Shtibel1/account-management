/**
 * Visual-order text for the Move-in file (an RTL field read left-to-right byte by byte).
 *
 * A simplified Unicode bidi (UBA) pass for an RTL paragraph:
 *  - strong L: Latin (and other LTR) letters; strong R: Hebrew (and other RTL scripts);
 *  - digits are European numbers (EN): a single "." "," ":" "/" "-" "+" between two digits joins
 *    them into one number ("12.50", "05-1234", "01/06/2026"), "%" next to a number belongs to it,
 *    and a number that follows Latin text is part of that Latin run ("IKEA 2");
 *  - neutrals (spaces, punctuation) take the direction of the strong text on both sides when it is
 *    the same (numbers count as R here, as in UBA rule N1), otherwise R (the paragraph direction).
 * The visual line is the runs in reverse order; RTL runs are reversed character by character (with
 * paired brackets mirrored), LTR / number runs keep their logical order. So "QA-ספק" becomes
 * "קפס-QA" and "IKEA ישראל" becomes "לארשי IKEA" - Latin / numbers are never written backwards
 * (QA N7), while "12 34" between Hebrew words is still laid out right-to-left ("34 12").
 */
export function toVisualHebrew(str: string | null | undefined): string {
  if (!str) return '';
  const chars = Array.from(str);
  const n = chars.length;
  const types: BidiType[] = chars.map(bidiType);

  // W4: a single separator between two numbers is part of the number.
  for (let i = 1; i < n - 1; i++) {
    if ((types[i] === 'ES' || types[i] === 'CS') && types[i - 1] === 'EN' && types[i + 1] === 'EN') types[i] = 'EN';
  }
  // W5: terminators ("%") adjacent to a number belong to it.
  for (let i = 0; i < n; i++) {
    if (types[i] !== 'ET') continue;
    let j = i;
    while (j < n && types[j] === 'ET') j++;
    if ((i > 0 && types[i - 1] === 'EN') || (j < n && types[j] === 'EN')) for (let k = i; k < j; k++) types[k] = 'EN';
    i = j - 1;
  }
  // W6: remaining separators / terminators are neutral.
  for (let i = 0; i < n; i++) if (types[i] === 'ES' || types[i] === 'CS' || types[i] === 'ET') types[i] = 'N';
  // W7: a number whose preceding strong character is L is L (start of paragraph counts as R).
  let lastStrong: 'L' | 'R' = 'R';
  for (let i = 0; i < n; i++) {
    if (types[i] === 'L' || types[i] === 'R') lastStrong = types[i] as 'L' | 'R';
    else if (types[i] === 'EN' && lastStrong === 'L') types[i] = 'L';
  }

  // N1/N2: neutrals between two strong sides of the same direction take it (EN counts as R),
  // otherwise the paragraph direction (R). Levels: R -> 1, L / EN -> 2 (an LTR run).
  const strongDir = (t: BidiType): 'L' | 'R' => (t === 'L' ? 'L' : 'R');
  const ltr: boolean[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const t = types[i];
    if (t !== 'N') {
      ltr[i] = t === 'L' || t === 'EN';
      continue;
    }
    let j = i;
    while (j < n && types[j] === 'N') j++;
    const before = i > 0 ? strongDir(types[i - 1]) : 'R';
    const after = j < n ? strongDir(types[j]) : 'R';
    const isLtr = before === 'L' && after === 'L';
    for (let k = i; k < j; k++) ltr[k] = isLtr;
    i = j - 1;
  }

  // Group into runs, then lay them out right-to-left. Adjacent L and EN characters share a level
  // (2) and therefore one LTR run, exactly like UBA rule L2.
  const runs: { ltr: boolean; text: string[] }[] = [];
  for (let i = 0; i < n; i++) {
    const last = runs[runs.length - 1];
    if (last && last.ltr === ltr[i]) last.text.push(chars[i]);
    else runs.push({ ltr: ltr[i], text: [chars[i]] });
  }
  return runs
    .reverse()
    .map((run) => (run.ltr ? run.text.join('') : run.text.reverse().map(mirror).join('')))
    .join('');
}

type BidiType = 'L' | 'R' | 'EN' | 'ES' | 'CS' | 'ET' | 'N';

const MIRRORED: Record<string, string> = { '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{', '<': '>', '>': '<' };

function mirror(ch: string): string {
  return MIRRORED[ch] ?? ch;
}

function bidiType(ch: string): BidiType {
  const code = ch.codePointAt(0) ?? 0;
  // Hebrew, Arabic, Syriac, Thaana, NKo ... and the Hebrew / Arabic presentation forms.
  if ((code >= 0x0590 && code <= 0x08ff) || (code >= 0xfb1d && code <= 0xfdff) || (code >= 0xfe70 && code <= 0xfeff)) return 'R';
  if (ch >= '0' && ch <= '9') return 'EN';
  if (ch === '+' || ch === '-') return 'ES';
  if (ch === '.' || ch === ',' || ch === ':' || ch === '/') return 'CS';
  if (ch === '%' || ch === '#' || ch === '$' || ch === '₪') return 'ET';
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
