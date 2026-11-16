// A number the OCR split into adjacent words (QA-p2: the receipt number "0941/3" was OCR'd as the
// words "3" and "0941", the model returned "30941", no single word matched and the viewer drew the
// model's guessed box over the header instead of the number).
import type { FieldBbox, OcrWord } from '@/shared/types';

/** At most this many adjacent words are joined. */
const MAX_PARTS = 3;
/** Shorter numbers are too likely to be assembled by chance. */
const MIN_DIGITS = 4;

const digitsOf = (text: string) => text.replace(/[^0-9]/g, '');

/** True when the words overlap vertically with the first one (same printed line). */
function sameLine(words: readonly OcrWord[]): boolean {
  const first = words[0].bbox;
  return words.every((w) => Math.min(first.y2, w.bbox.y2) > Math.max(first.y1, w.bbox.y1));
}

/**
 * The box of 2-3 consecutive OCR words on one line whose digits, joined in reading order or in
 * reverse (RTL lines list LTR numbers either way), equal the target number; undefined otherwise.
 * Every word must be a number (separators like "/" or "-" allowed) so labels never join in.
 */
export function findSplitNumberBbox(target: string | number | null | undefined, words: readonly OcrWord[]): FieldBbox | undefined {
  if (target == null) return undefined;
  const raw = String(target).trim();
  if (!/^[0-9][0-9 /\-.]*$/.test(raw)) return undefined;
  const wanted = digitsOf(raw);
  if (wanted.length < MIN_DIGITS) return undefined;

  for (let i = 0; i < words.length; i++) {
    for (let n = 2; n <= MAX_PARTS && i + n <= words.length; n++) {
      const seq = words.slice(i, i + n);
      if (seq.some((w) => w.page !== seq[0].page || !/^[0-9 /\-.]*[0-9][0-9 /\-.]*$/.test(w.text.trim()))) break;
      if (!sameLine(seq)) break;
      const parts = seq.map((w) => digitsOf(w.text));
      const forward = parts.join('');
      const backward = [...parts].reverse().join('');
      if (forward.length > wanted.length) break;
      if (forward === wanted || backward === wanted) {
        return {
          x1: Math.min(...seq.map((w) => w.bbox.x1)),
          y1: Math.min(...seq.map((w) => w.bbox.y1)),
          x2: Math.max(...seq.map((w) => w.bbox.x2)),
          y2: Math.max(...seq.map((w) => w.bbox.y2)),
          page: seq[0].page,
        };
      }
    }
  }
  return undefined;
}
