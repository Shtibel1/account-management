'use client';

import { useEffect, useRef, useState } from 'react';
import { BboxMap, FieldBbox } from '@/shared/types';
import { Document, Page, pdfjs } from 'react-pdf';

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
  
  const pageRefs = useRef<Record<number, HTMLElement | null>>({});
  const observers = useRef<Record<number, ResizeObserver>>({});

  const isPdf = fileUrl.toLowerCase().includes('.pdf') || fileUrl.includes('content-type=application%2Fpdf');

  // Set up resize observer for each page or image to get layout dimensions
  const setPageRef = (pageNumber: number) => (el: HTMLElement | null) => {
    pageRefs.current[pageNumber] = el;
    
    // Clean up existing observer for this page
    if (observers.current[pageNumber]) {
      observers.current[pageNumber].disconnect();
      delete observers.current[pageNumber];
    }

    if (!el) {
      setPageSizes((prev) => {
        const next = { ...prev };
        delete next[pageNumber];
        return next;
      });
      return;
    }

    const updateSize = () => {
      setPageSizes((prev) => {
        if (prev[pageNumber]?.w === el.offsetWidth && prev[pageNumber]?.h === el.offsetHeight) {
          return prev;
        }
        return {
          ...prev,
          [pageNumber]: { w: el.offsetWidth, h: el.offsetHeight },
        };
      });
    };

    updateSize();
    const ro = new ResizeObserver(updateSize);
    ro.observe(el);
    observers.current[pageNumber] = ro;
  };

  // Cleanup observers on unmount
  useEffect(() => {
    return () => {
      // eslint-disable-next-line react-hooks/exhaustive-deps
      Object.values(observers.current).forEach((ro) => ro.disconnect());
    };
  }, []);

  // Auto-scroll to center the active highlighted field in the viewport
  useEffect(() => {
    if (!activeField || !bboxes) return;
    const b = bboxes[activeField as keyof BboxMap];
    if (!b) return;

    const container = containerRef.current;
    if (!container) return;

    const pageNum = b.page ?? 1;
    const pageElement = pageRefs.current[pageNum];
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
  }, [activeField, bboxes, pageSizes, yOffset]);

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

  return (
    <div
      ref={containerRef}
      dir="ltr"
      className="relative w-full h-full overflow-auto bg-gray-100 flex flex-col items-center p-4 gap-4"
      style={{ direction: 'ltr' }}
    >
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
            return (
              <div
                key={pageNum}
                className="relative bg-white shadow-md border border-slate-200 rounded max-w-full"
                dir="ltr"
                style={{ direction: 'ltr' }}
              >
                <Page
                  pageNumber={pageNum}
                  renderTextLayer={false}
                  renderAnnotationLayer={false}
                  canvasRef={setPageRef(pageNum)}
                  className="max-w-full h-auto"
                />
                {renderOverlayForPage(pageNum, pageSize)}
              </div>
            );
          })}
        </Document>
      ) : (
        <div className="relative inline-block bg-white shadow-md border border-slate-200 rounded max-w-full" dir="ltr" style={{ direction: 'ltr' }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            ref={setPageRef(1)}
            src={fileUrl}
            alt="חשבונית מקורית"
            className="block max-w-full h-auto rounded select-none"
            draggable={false}
          />
          {renderOverlayForPage(1, pageSizes[1] || { w: 0, h: 0 })}
        </div>
      )}
    </div>
  );
}
