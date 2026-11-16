/** Zoom math of the original-document viewer (src/components/SplitPane/ImageViewer.tsx). Pure. */

export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 4;
/** One click of the + / - buttons. */
export const ZOOM_STEP = 1.25;

export function clampZoom(z: number): number {
  if (!Number.isFinite(z)) return 1;
  // Snap to exactly 1 near it, so "fit" is reachable with the buttons after a pinch
  const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
  return Math.abs(clamped - 1) < 0.02 ? 1 : Math.round(clamped * 1000) / 1000;
}

/**
 * Scroll position after zooming by `ratio` (new / old) that keeps the content point under
 * `pointer` (container coords) in place. `pad` is the scroll area's padding (not scaled).
 */
export function zoomScrollFor(
  scroll: { left: number; top: number },
  pointer: { x: number; y: number },
  ratio: number,
  pad: { x: number; y: number } = { x: 0, y: 0 }
): { left: number; top: number } {
  const contentX = scroll.left + pointer.x - pad.x;
  const contentY = scroll.top + pointer.y - pad.y;
  return {
    left: Math.max(0, contentX * ratio + pad.x - pointer.x),
    top: Math.max(0, contentY * ratio + pad.y - pointer.y),
  };
}

/** A point relative to an element's center after CSS `rotate(deg)` (clockwise, y pointing down). */
export function rotatedPoint(p: { x: number; y: number }, deg: number): { x: number; y: number } {
  const r = (((deg % 360) + 360) % 360);
  if (r === 90) return { x: -p.y, y: p.x };
  if (r === 180) return { x: -p.x, y: -p.y };
  if (r === 270) return { x: p.y, y: -p.x };
  return { x: p.x, y: p.y };
}
