/**
 * Page orientation from Google Vision's OCR boxes (no extra API call).
 *
 * Vision lists a word's box vertices in the word's *reading* order - top-left, top-right,
 * bottom-right, bottom-left as if the text were upright - also when the text is rotated on the
 * page. So the vector from the box's top edge to its bottom edge says which way "down" points:
 * straight down on an upright scan, straight up on an upside-down one. That direction is the same
 * for Hebrew and English words (only the top/bottom pairs are used, not left/right).
 */

export type QuarterTurn = 0 | 90 | 180 | 270;
export type PageTurn = Exclude<QuarterTurn, 0>;

interface Vertex { x?: number; y?: number }

/**
 * Clockwise rotation (CSS `rotate()`, degrees) that makes this word upright, or 0 when the box
 * doesn't say. `scaleX` / `scaleY` turn normalized vertices into the page's real proportions.
 */
export function uprightRotationOfBox(vertices: readonly Vertex[] | null | undefined, scaleX = 1, scaleY = 1): QuarterTurn {
  if (!vertices || vertices.length < 4) return 0;
  const [v0, v1, v2, v3] = vertices.map((v) => ({ x: (v?.x ?? 0) * scaleX, y: (v?.y ?? 0) * scaleY }));
  // top edge midpoint -> bottom edge midpoint = the text's "down"
  const dx = (v2.x + v3.x - v0.x - v1.x) / 2;
  const dy = (v2.y + v3.y - v0.y - v1.y) / 2;
  if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return 0;
  if (Math.abs(dy) >= Math.abs(dx)) return dy > 0 ? 0 : 180;
  // "down" points right: the page was turned counter-clockwise, turn it back clockwise (and vice versa)
  return dx > 0 ? 90 : 270;
}

/** Fewest words on a page before its orientation is trusted. */
export const MIN_ORIENTATION_WORDS = 8;
/** Share of the page's text (by characters) that must agree on one orientation. */
export const MIN_ORIENTATION_SHARE = 0.7;

/**
 * Per-page rotation the viewer applies automatically: `{ "<page>": 90 | 180 | 270 }`, only for
 * pages that need one (upright pages are left out). Words are OcrWord-like (`rot` = the word's
 * rotation from uprightRotationOfBox, absent = upright; `page` defaults to 1). Returns null when
 * every page is upright, so nothing is stored for the usual case.
 */
export function pageRotationsFromWords(
  words: readonly { text?: string; page?: number; rot?: number }[] | null | undefined
): Record<string, PageTurn> | null {
  if (!words || words.length === 0) return null;
  const perPage = new Map<number, { count: number; weight: Record<QuarterTurn, number> }>();
  for (const w of words) {
    const page = typeof w.page === 'number' ? w.page : 1;
    const rot = normalizeQuarterTurn(w.rot);
    const entry = perPage.get(page) ?? { count: 0, weight: { 0: 0, 90: 0, 180: 0, 270: 0 } };
    entry.count++;
    entry.weight[rot] += Math.max(1, (w.text ?? '').length);
    perPage.set(page, entry);
  }
  const out: Record<string, PageTurn> = {};
  for (const [page, { count, weight }] of perPage) {
    if (count < MIN_ORIENTATION_WORDS) continue;
    const total = weight[0] + weight[90] + weight[180] + weight[270];
    let best: PageTurn = 90;
    for (const r of [180, 270] as const) if (weight[r] > weight[best]) best = r;
    if (weight[best] > weight[0] && weight[best] / total >= MIN_ORIENTATION_SHARE) out[String(page)] = best;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Any degree value -> 0 / 90 / 180 / 270 (anything else is 0). */
export function normalizeQuarterTurn(value: unknown): QuarterTurn {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 0;
  const r = ((n % 360) + 360) % 360;
  return r === 90 || r === 180 || r === 270 ? r : 0;
}

/** Sanitizes a stored `page_rotations` value for the viewer. */
export function readPageRotations(value: unknown): Record<string, PageTurn> {
  const out: Record<string, PageTurn> = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [page, rot] of Object.entries(value as Record<string, unknown>)) {
    const r = normalizeQuarterTurn(rot);
    if (r !== 0 && /^\d+$/.test(page)) out[page] = r;
  }
  return out;
}
