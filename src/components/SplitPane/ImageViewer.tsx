'use client';

import { useEffect, useRef, useState } from 'react';
import { BboxMap, FieldBbox } from '@/shared/types';
import { Document, Page, pdfjs } from 'react-pdf';
import { RotateCw } from 'lucide-react';

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

interface Props {
  fileUrl: string;
  bboxes?: BboxMap;
  activeField: string | null;
  showAll: boolean;
  yOffset?: number; // היסט אנכי לכיול (ערך 0-1, ברירת מחדל 0)
}

export function ImageViewer({ fileUrl, bboxes, activeField, showAll, yOffset = 0 }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [numPages, setNumPages] = useState<number | null>(null);
  const [pageSizes, setPageSizes] = useState<Record<number, { w: number; h: number }>>({});
  const [rotation, setRotation] = useState(0); // 0, 90, 180, 270

  const isPdf = fileUrl.toLowerCase().includes('.pdf') || fileUrl.includes('content-type=application%2Fpdf');

  // central measurement trigger
  const updateSizes = () => {
    const container = containerRef.current;
    if (!container) return;

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
  };

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
    mo.observe(container, { childList: true, subtree: true });

    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, [fileUrl, numPages]);

  // Auto-scroll to center the active highlighted field in the viewport
  useEffect(() => {
    if (!activeField || !bboxes) return;
    const b = bboxes[activeField as keyof BboxMap];
    if (!b) return;

    const container = containerRef.current;
    if (!container) return;

    const pageNum = b.page ?? 1;
    let pageElement: HTMLElement | null = null;
    if (isPdf) {
      pageElement = container.querySelector(`.react-pdf__Page[data-page-number="${pageNum}"] canvas`);
    } else {
      pageElement = container.querySelector('img');
    }

    const size = pageSizes[pageNum];
    if (!pageElement || !size || size.h === 0) return;

    const rect = pageElement.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const elementTop = rect.top - containerRect.top + container.scrollTop;

    // Calculate vertical position of bounding box on the page/image
    const y1 = (b.y1 + yOffset) * size.h;
    const y2 = (b.y2 + yOffset) * size.h;
    const fieldCenter = (y1 + y2) / 2;

    // Absolute center in the scroll container
    const absoluteCenter = elementTop + fieldCenter;

    // Center in the container viewport
    const containerHeight = container.clientHeight;
    const targetScrollTop = absoluteCenter - containerHeight / 2;

    container.scrollTo({
      top: Math.max(0, targetScrollTop),
      behavior: 'smooth',
    });
  }, [activeField, bboxes, pageSizes, yOffset, isPdf]);

  const onDocumentLoadSuccess = ({ numPages }: { numPages: number }) => {
    setNumPages(numPages);
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

  const isRotated90 = rotation === 90 || rotation === 270;

  return (
    <div
      ref={containerRef}
      dir="ltr"
      className="relative w-full h-full overflow-auto bg-gray-100 flex flex-col items-center p-4 gap-4"
      style={{ direction: 'ltr' }}
    >
      {/* Floating Toolbar */}
      <div className="sticky top-2 self-end z-10 mr-2 -mb-10 pointer-events-none">
        <button
          onClick={() => setRotation((r) => (r + 90) % 360)}
          className="pointer-events-auto flex items-center gap-1.5 px-3 py-2 bg-white/95 hover:bg-white text-slate-700 text-xs font-semibold rounded-xl border border-slate-200 shadow-md hover:shadow-lg transition-all backdrop-blur-sm select-none"
          title="סובב מסמך 90 מעלות"
        >
          <RotateCw className="h-3.5 w-3.5" />
          סובב מסמך
        </button>
      </div>

      {isPdf ? (
        <Document
          file={fileUrl}
          onLoadSuccess={onDocumentLoadSuccess}
          loading={<div className="text-slate-400 py-4 text-center">טוען קובץ PDF...</div>}
          error={<div className="text-rose-500 py-4 text-center">שגיאה בטעינת קובץ ה-PDF</div>}
          className="flex flex-col items-center gap-4 w-full"
        >
          {Array.from(new Array(numPages ?? 0), (el, index) => {
            const pageNum = index + 1;
            const pageSize = pageSizes[pageNum] || { w: 0, h: 0 };
            
            // Layout margin adjustments to swap aspect ratios smoothly inside scroll bounds
            const pageStyle: React.CSSProperties = {
              direction: 'ltr',
              transform: `rotate(${rotation}deg)`,
              transformOrigin: 'center center',
              transition: 'transform 0.2s ease-in-out',
              ...(isRotated90 && pageSize.w > 0 && pageSize.h > 0 ? {
                marginTop: `${(pageSize.w - pageSize.h) / 2}px`,
                marginBottom: `${(pageSize.w - pageSize.h) / 2}px`,
                marginLeft: `${(pageSize.h - pageSize.w) / 2}px`,
                marginRight: `${(pageSize.h - pageSize.w) / 2}px`,
              } : {})
            };

            return (
              <div
                key={pageNum}
                className="relative bg-white shadow-md border border-slate-200 rounded max-w-full"
                dir="ltr"
                style={pageStyle}
              >
                <Page
                  pageNumber={pageNum}
                  renderTextLayer={false}
                  renderAnnotationLayer={false}
                  className="max-w-full h-auto"
                />
                {renderOverlayForPage(pageNum, pageSize)}
              </div>
            );
          })}
        </Document>
      ) : (
        (() => {
          const imgPageSize = pageSizes[1] || { w: 0, h: 0 };
          const imgStyle: React.CSSProperties = {
            direction: 'ltr',
            transform: `rotate(${rotation}deg)`,
            transformOrigin: 'center center',
            transition: 'transform 0.2s ease-in-out',
            ...(isRotated90 && imgPageSize.w > 0 && imgPageSize.h > 0 ? {
              marginTop: `${(imgPageSize.w - imgPageSize.h) / 2}px`,
              marginBottom: `${(imgPageSize.w - imgPageSize.h) / 2}px`,
              marginLeft: `${(imgPageSize.h - imgPageSize.w) / 2}px`,
              marginRight: `${(imgPageSize.h - imgPageSize.w) / 2}px`,
            } : {})
          };

          return (
            <div
              className="relative inline-block bg-white shadow-md border border-slate-200 rounded max-w-full"
              dir="ltr"
              style={imgStyle}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={fileUrl}
                alt="חשבונית מקורית"
                className="block max-w-full h-auto rounded select-none"
                draggable={false}
                onLoad={updateSizes}
              />
              {renderOverlayForPage(1, imgPageSize)}
            </div>
          );
        })()
      )}
    </div>
  );
}
