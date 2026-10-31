'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { BboxMap, FieldBbox } from '@/shared/types';
import { Document, Page, pdfjs } from 'react-pdf';
import { Minus, Plus, RotateCw } from 'lucide-react';
import { readPageRotations } from '@/shared/orientation';
import { MAX_ZOOM, MIN_ZOOM, ZOOM_STEP, clampZoom, rotatedPoint, zoomScrollFor } from '@/shared/viewerZoom';

// Import react-pdf styles for correct page layouts
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

// Configure pdfjs worker to run on client
pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

const FIELD_COLORS: Record<string, string> = {
  supplier_name:     '#3b82f6', // blue
  supplier_vat_id:   '#8b5cf6', // purple
  invoice_number:    '#06b6d4', // cyan
  invoice_date:      '#f59e0b', // amber
  amount_before_vat: '#10b981', // green
  vat_amount:        '#ef4444', // red
  total_amount:      '#f97316', // orange
  expense_category:  '#ec4899', // pink
};

/** Padding of the scroll area: px-4, pt-12 (room for the toolbar). */
const PAD = { x: 16, y: 48 };
/** A ctrl+wheel / pinch gesture is committed (pages re-rendered) after this much quiet. */
const GESTURE_COMMIT_MS = 180;

interface Props {
  fileUrl: string;
  bboxes?: BboxMap;
  activeField: string | null;
  showAll: boolean;
  yOffset?: number; // היסט אנכי לכיול (ערך 0-1, ברירת מחדל 0)
  /** Pages scanned sideways / upside down: `{ "<page>": 90 | 180 | 270 }` (extracted_data.page_rotations). */
  pageRotations?: unknown;
}

interface Anchor { cx: number; cy: number; from: number }

export function ImageViewer({ fileUrl, bboxes, activeField, showAll, yOffset = 0, pageRotations }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [numPages, setNumPages] = useState<number | null>(null);
  const [pageSizes, setPageSizes] = useState<Record<number, { w: number; h: number }>>({});
  /** Height / width of each page at rotation 0 (from the PDF page or the image's natural size). */
  const [aspects, setAspects] = useState<Record<number, number>>({});
  const [rotation, setRotation] = useState(0); // the reviewer's turns, on top of the automatic one
  const [zoom, setZoom] = useState(1); // 1 = page width fits the pane
  const [preview, setPreview] = useState<{ scale: number; ox: number; oy: number } | null>(null);
  const [fitWidth, setFitWidth] = useState(0);

  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const anchorRef = useRef<Anchor | null>(null);
  const gestureRef = useRef<{ scale: number; cx: number; cy: number; timer: ReturnType<typeof setTimeout> | null } | null>(null);
  const pinchRef = useRef<{ dist: number; cx: number; cy: number } | null>(null);
  const panRef = useRef<{ x: number; y: number; left: number; top: number; id: number } | null>(null);
  const [panning, setPanning] = useState(false);

  const autoRotations = readPageRotations(pageRotations);
  const isPdf = fileUrl.toLowerCase().includes('.pdf') || fileUrl.includes('content-type=application%2Fpdf');

  const pageRotation = (pageNum: number) => ((autoRotations[String(pageNum)] ?? 0) + rotation) % 360;

  // central measurement trigger
  const updateSizes = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    setFitWidth((prev) => {
      const next = Math.max(120, container.clientWidth - 2 * PAD.x);
      return Math.abs(prev - next) > 1 ? next : prev;
    });

    // Find all PDF canvas elements or image element
    const elements = container.querySelectorAll('.react-pdf__Page canvas, img');
    if (elements.length === 0) return;

    setPageSizes((prev) => {
      let changed = false;
      const next = { ...prev };

      elements.forEach((el) => {
        let pageNum = 1;
        const pageWrapper = el.closest('.react-pdf__Page');
        if (pageWrapper) {
          const pageAttr = pageWrapper.getAttribute('data-page-number');
          if (pageAttr) pageNum = parseInt(pageAttr, 10);
        }

        const w = (el as HTMLElement).offsetWidth;
        const h = (el as HTMLElement).offsetHeight;

        if (w > 0 && h > 0) {
          if (prev[pageNum]?.w !== w || prev[pageNum]?.h !== h) {
            next[pageNum] = { w, h };
            changed = true;
          }
        }
      });

      return changed ? next : prev;
    });
  }, []);

  // Unified layout observer to handle client-side rendering size updates
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    updateSizes();

    // ResizeObserver watches for browser resizing and layout reflows
    const ro = new ResizeObserver(updateSizes);
    ro.observe(container);

    // MutationObserver detects when react-pdf finishes async page renders and inserts canvas tags
    const mo = new MutationObserver(updateSizes);
    mo.observe(container, { childList: true, subtree: true, attributes: true, attributeFilter: ['width', 'height', 'style'] });

    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, [fileUrl, numPages, updateSizes]);

  // A new file starts at "fit" again
  useEffect(() => {
    setZoom(1);
    setRotation(0);
    setAspects({});
    setPageSizes({});
  }, [fileUrl]);

  // ── Zoom ────────────────────────────────────────────────────────────────────

  /** Zooms to `next`, keeping the content point under (cx, cy) (container coords) in place. */
  const zoomTo = useCallback((next: number, cx?: number, cy?: number) => {
    const container = containerRef.current;
    const from = zoomRef.current;
    const target = clampZoom(next);
    if (!container || target === from) return;
    anchorRef.current = {
      cx: cx ?? container.clientWidth / 2,
      cy: cy ?? container.clientHeight / 2,
      from,
    };
    setZoom(target);
  }, []);

  // After a zoom, scroll so the anchor point stays under the pointer / pane center
  useLayoutEffect(() => {
    const container = containerRef.current;
    const anchor = anchorRef.current;
    if (!container || !anchor) return;
    anchorRef.current = null;
    const pos = zoomScrollFor(
      { left: container.scrollLeft, top: container.scrollTop },
      { x: anchor.cx, y: anchor.cy },
      zoom / anchor.from,
      PAD
    );
    container.scrollLeft = pos.left;
    container.scrollTop = pos.top;
  }, [zoom]);

  /** Live gesture (ctrl+wheel / pinch): scale with CSS first, re-render the pages when it settles. */
  const gestureScale = useCallback((factor: number, cx: number, cy: number, commitAfterMs: number | null) => {
    const container = containerRef.current;
    if (!container) return;
    const g = gestureRef.current ?? { scale: 1, cx, cy, timer: null };
    const from = zoomRef.current;
    g.scale = clampZoom(from * g.scale * factor) / from;
    g.cx = cx;
    g.cy = cy;
    gestureRef.current = g;
    setPreview({ scale: g.scale, ox: container.scrollLeft + cx, oy: container.scrollTop + cy });
    if (g.timer) clearTimeout(g.timer);
    g.timer = commitAfterMs === null ? null : setTimeout(() => commitGesture(), commitAfterMs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const commitGesture = useCallback(() => {
    const g = gestureRef.current;
    gestureRef.current = null;
    setPreview(null);
    if (!g) return;
    if (g.timer) clearTimeout(g.timer);
    zoomTo(zoomRef.current * g.scale, g.cx, g.cy);
  }, [zoomTo]);

  // ctrl+wheel (and a laptop trackpad's pinch, which arrives as ctrl+wheel); pinch on touch screens.
  // Native listeners: React's wheel / touch handlers are passive, so they can't stop the page zoom.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const local = (clientX: number, clientY: number) => {
      const r = container.getBoundingClientRect();
      return { x: clientX - r.left, y: clientY - r.top };
    };

    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? container.clientHeight : 1;
      const factor = Math.exp(-e.deltaY * unit * 0.002);
      const p = local(e.clientX, e.clientY);
      gestureScale(factor, p.x, p.y, GESTURE_COMMIT_MS);
    };

    const touchInfo = (t: TouchList) => {
      const a = t[0];
      const b = t[1];
      const p = local((a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2);
      return { dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), cx: p.x, cy: p.y };
    };
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        pinchRef.current = touchInfo(e.touches);
        e.preventDefault();
      }
    };
    const onTouchMove = (e: TouchEvent) => {
      const start = pinchRef.current;
      if (!start || e.touches.length !== 2) return;
      e.preventDefault();
      const now = touchInfo(e.touches);
      if (start.dist <= 0) return;
      // gestureScale multiplies: pass the change since the last move
      const current = gestureRef.current?.scale ?? 1;
      gestureScale(now.dist / start.dist / current, start.cx, start.cy, null);
    };
    const onTouchEnd = (e: TouchEvent) => {
      if (pinchRef.current && e.touches.length < 2) {
        pinchRef.current = null;
        commitGesture();
      }
    };

    container.addEventListener('wheel', onWheel, { passive: false });
    container.addEventListener('touchstart', onTouchStart, { passive: false });
    container.addEventListener('touchmove', onTouchMove, { passive: false });
    container.addEventListener('touchend', onTouchEnd);
    container.addEventListener('touchcancel', onTouchEnd);
    return () => {
      container.removeEventListener('wheel', onWheel);
      container.removeEventListener('touchstart', onTouchStart);
      container.removeEventListener('touchmove', onTouchMove);
      container.removeEventListener('touchend', onTouchEnd);
      container.removeEventListener('touchcancel', onTouchEnd);
    };
  }, [gestureScale, commitGesture]);

  // Drag to pan with the mouse while zoomed in (touch screens pan by scrolling natively)
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const container = containerRef.current;
    if (!container || e.pointerType !== 'mouse' || e.button !== 0 || zoom <= 1) return;
    panRef.current = { x: e.clientX, y: e.clientY, left: container.scrollLeft, top: container.scrollTop, id: e.pointerId };
    container.setPointerCapture?.(e.pointerId);
    setPanning(true);
    e.preventDefault();
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const container = containerRef.current;
    const pan = panRef.current;
    if (!container || !pan || pan.id !== e.pointerId) return;
    container.scrollLeft = pan.left - (e.clientX - pan.x);
    container.scrollTop = pan.top - (e.clientY - pan.y);
  };
  const endPan = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!panRef.current || panRef.current.id !== e.pointerId) return;
    panRef.current = null;
    containerRef.current?.releasePointerCapture?.(e.pointerId);
    setPanning(false);
  };

  // Keyboard: ctrl/cmd + "+" / "-" / "0" while the viewer has focus
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!e.ctrlKey && !e.metaKey) return;
    if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomTo(zoom * ZOOM_STEP); }
    else if (e.key === '-') { e.preventDefault(); zoomTo(zoom / ZOOM_STEP); }
    else if (e.key === '0') { e.preventDefault(); zoomTo(1); }
  };

  // ── Active field: scroll it to the center of the pane ───────────────────────

  useEffect(() => {
    if (!activeField || !bboxes) return;
    const b = bboxes[activeField as keyof BboxMap];
    if (!b) return;

    const container = containerRef.current;
    if (!container) return;

    const pageNum = b.page ?? 1;
    const pageWrapper = container.querySelector<HTMLElement>(`[data-viewer-page="${pageNum}"]`);
    const size = pageSizes[pageNum];
    if (!pageWrapper || !size || size.h === 0) return;

    // The wrapper is rotated around its center: map the box center through the same turn
    const rect = pageWrapper.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const local = {
      x: ((b.x1 + b.x2) / 2) * size.w - size.w / 2,
      y: ((b.y1 + b.y2) / 2 + yOffset) * size.h - size.h / 2,
    };
    const turned = rotatedPoint(local, pageRotation(pageNum));
    const absoluteX = rect.left + rect.width / 2 - containerRect.left + container.scrollLeft + turned.x;
    const absoluteY = rect.top + rect.height / 2 - containerRect.top + container.scrollTop + turned.y;

    container.scrollTo({
      top: Math.max(0, absoluteY - container.clientHeight / 2),
      left: Math.max(0, absoluteX - container.clientWidth / 2),
      behavior: 'smooth',
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeField, bboxes, pageSizes, yOffset, isPdf]);

  const onDocumentLoadSuccess = ({ numPages }: { numPages: number }) => {
    setNumPages(numPages);
  };

  const rememberAspect = (pageNum: number, w: number, h: number) => {
    if (!(w > 0 && h > 0)) return;
    const aspect = h / w;
    setAspects((prev) => (Math.abs((prev[pageNum] ?? 0) - aspect) < 1e-4 ? prev : { ...prev, [pageNum]: aspect }));
  };

  /** Rendered width of a page (before its rotation): its on-screen width fits the pane at zoom 1. */
  const pageWidth = (pageNum: number): number | undefined => {
    if (fitWidth <= 0) return undefined;
    const rot = pageRotation(pageNum);
    const aspect = aspects[pageNum];
    const sideways = rot === 90 || rot === 270;
    const fit = sideways && aspect ? fitWidth / aspect : fitWidth;
    return Math.max(40, Math.round(fit * zoom));
  };

  const pageStyle = (pageNum: number): React.CSSProperties => {
    const rot = pageRotation(pageNum);
    const size = pageSizes[pageNum] || { w: 0, h: 0 };
    const sideways = rot === 90 || rot === 270;
    return {
      direction: 'ltr',
      transform: rot ? `rotate(${rot}deg)` : undefined,
      transformOrigin: 'center center',
      transition: 'transform 0.2s ease-in-out',
      // Layout margin adjustments to swap aspect ratios smoothly inside scroll bounds
      ...(sideways && size.w > 0 && size.h > 0 ? {
        marginTop: `${(size.w - size.h) / 2}px`,
        marginBottom: `${(size.w - size.h) / 2}px`,
        marginLeft: `${(size.h - size.w) / 2}px`,
        marginRight: `${(size.h - size.w) / 2}px`,
      } : {}),
    };
  };

  const renderOverlayForPage = (pageNum: number, size: { w: number; h: number }) => {
    if (!bboxes || size.w === 0) return null;

    const fieldsToShow = activeField
      ? ([activeField] as (keyof BboxMap)[])
      : showAll
      ? (Object.keys(bboxes) as (keyof BboxMap)[])
      : [];

    return (
      <svg
        className="absolute inset-0 pointer-events-none"
        width={size.w}
        height={size.h}
        style={{ top: 0, left: 0, direction: 'ltr' }}
      >
        {fieldsToShow.map((field) => {
          const b = bboxes[field] as FieldBbox | undefined;
          if (!b) return null;

          // Default to page 1 for legacy bboxes
          const bboxPage = b.page ?? 1;
          if (bboxPage !== pageNum) return null;

          // Skip rendering bounding boxes with zero width/height or invalid zeros to avoid line artifacts
          if ((b.x1 === 0 && b.y1 === 0 && b.x2 === 0 && b.y2 === 0) || b.x1 === b.x2 || b.y1 === b.y2) {
            return null;
          }

          const color = FIELD_COLORS[field] ?? '#6b7280';
          const x = b.x1 * size.w;
          const y = (b.y1 + yOffset) * size.h;
          const w = (b.x2 - b.x1) * size.w;
          const h = (b.y2 - b.y1) * size.h;
          const isActive = field === activeField;

          return (
            <g key={field}>
              <rect
                x={x} y={y} width={w} height={h}
                fill={color}
                fillOpacity={isActive ? 0.18 : 0.08}
                stroke={color}
                strokeWidth={isActive ? 2.5 : 1.5}
                strokeOpacity={isActive ? 1 : 0.6}
                rx={3}
              />
            </g>
          );
        })}
      </svg>
    );
  };

  const shownZoom = Math.round(zoom * (preview?.scale ?? 1) * 100);
  const toolButton =
    'pointer-events-auto flex items-center justify-center h-8 min-w-8 px-2 bg-white/95 hover:bg-white text-slate-700 text-xs font-semibold border border-slate-200 transition-colors select-none disabled:opacity-40 disabled:cursor-not-allowed';

  return (
    <div className="relative w-full h-full" dir="ltr">
      {/* Floating toolbar (outside the scroll area, so it stays put while panning) */}
      <div
        dir="rtl"
        className="absolute top-2 right-2 z-10 flex items-center gap-2 pointer-events-none"
        role="toolbar"
        aria-label="כלי תצוגת מסמך"
      >
        <div className="flex items-center rounded-xl shadow-md overflow-hidden backdrop-blur-sm" data-testid="viewer-zoom-controls">
          <button
            type="button"
            onClick={() => zoomTo(zoom * ZOOM_STEP)}
            disabled={zoom >= MAX_ZOOM}
            className={`${toolButton} rounded-r-xl`}
            title="הגדל (Ctrl + גלגלת)"
            aria-label="הגדל"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => zoomTo(1)}
            className={`${toolButton} border-x-0 tabular-nums w-14`}
            title="התאם לרוחב (איפוס זום)"
            aria-label={`איפוס זום (${shownZoom}%)`}
          >
            {shownZoom}%
          </button>
          <button
            type="button"
            onClick={() => zoomTo(zoom / ZOOM_STEP)}
            disabled={zoom <= MIN_ZOOM}
            className={`${toolButton} rounded-l-xl`}
            title="הקטן"
            aria-label="הקטן"
          >
            <Minus className="h-3.5 w-3.5" />
          </button>
        </div>
        <button
          type="button"
          onClick={() => setRotation((r) => (r + 90) % 360)}
          className="pointer-events-auto flex items-center gap-1.5 h-8 px-3 bg-white/95 hover:bg-white text-slate-700 text-xs font-semibold rounded-xl border border-slate-200 shadow-md hover:shadow-lg transition-all backdrop-blur-sm select-none"
          title="סובב מסמך 90 מעלות"
        >
          <RotateCw className="h-3.5 w-3.5" />
          סובב מסמך
        </button>
      </div>

      <div
        ref={containerRef}
        dir="ltr"
        tabIndex={0}
        data-testid="document-viewer"
        className={`w-full h-full overflow-auto bg-gray-100 outline-none ${zoom > 1 ? (panning ? 'cursor-grabbing' : 'cursor-grab') : ''}`}
        // Pan with one finger, pinch handled here (not by the browser's page zoom)
        style={{ direction: 'ltr', touchAction: 'pan-x pan-y' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPan}
        onPointerCancel={endPan}
        onKeyDown={onKeyDown}
      >
        {/* w-max + min-w-full: a zoomed page widens the scroll area to the right only, so all of it can be reached */}
        <div
          ref={contentRef}
          className="w-max min-w-full flex flex-col items-center gap-4 pt-12 pb-4 px-4"
          style={preview ? { transform: `scale(${preview.scale})`, transformOrigin: `${preview.ox}px ${preview.oy}px` } : undefined}
        >
          {isPdf ? (
            <Document
              file={fileUrl}
              onLoadSuccess={onDocumentLoadSuccess}
              loading={<div dir="rtl" className="text-slate-400 py-4 text-center">טוען קובץ PDF...</div>}
              error={<div dir="rtl" className="text-rose-500 py-4 text-center">שגיאה בטעינת קובץ ה-PDF</div>}
              className="flex flex-col items-center gap-4"
            >
              {Array.from(new Array(numPages ?? 0), (el, index) => {
                const pageNum = index + 1;
                const pageSize = pageSizes[pageNum] || { w: 0, h: 0 };
                return (
                  <div
                    key={pageNum}
                    data-viewer-page={pageNum}
                    data-rotation={pageRotation(pageNum)}
                    className="relative bg-white shadow-md border border-slate-200 rounded"
                    dir="ltr"
                    style={pageStyle(pageNum)}
                  >
                    <Page
                      pageNumber={pageNum}
                      width={pageWidth(pageNum)}
                      renderTextLayer={false}
                      renderAnnotationLayer={false}
                      onLoadSuccess={(page) => rememberAspect(pageNum, page.originalWidth, page.originalHeight)}
                    />
                    {renderOverlayForPage(pageNum, pageSize)}
                  </div>
                );
              })}
            </Document>
          ) : (
            <div
              data-viewer-page={1}
              data-rotation={pageRotation(1)}
              className="relative inline-block bg-white shadow-md border border-slate-200 rounded"
              dir="ltr"
              style={pageStyle(1)}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={fileUrl}
                alt="חשבונית מקורית"
                className="block h-auto rounded select-none max-w-none"
                style={{ width: pageWidth(1) }}
                draggable={false}
                onLoad={(e) => {
                  rememberAspect(1, e.currentTarget.naturalWidth, e.currentTarget.naturalHeight);
                  updateSizes();
                }}
              />
              {renderOverlayForPage(1, pageSizes[1] || { w: 0, h: 0 })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
