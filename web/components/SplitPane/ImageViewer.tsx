'use client';

import { useEffect, useRef, useState } from 'react';
import { BboxMap, FieldBbox } from '@invoice/shared-types';
import clsx from 'clsx';

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
  const imgRef = useRef<HTMLImageElement>(null);
  const [imgSize, setImgSize] = useState({ w: 0, h: 0 });
  const isPdf = fileUrl.toLowerCase().includes('.pdf') || fileUrl.includes('content-type=application%2Fpdf');

  useEffect(() => {
    const img = imgRef.current;
    if (!img) return;
    const update = () => setImgSize({ w: img.offsetWidth, h: img.offsetHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(img);
    return () => ro.disconnect();
  }, []);

  const renderOverlay = () => {
    if (!bboxes || imgSize.w === 0) return null;

    const fieldsToShow = activeField
      ? ([activeField] as (keyof BboxMap)[])
      : showAll
      ? (Object.keys(bboxes) as (keyof BboxMap)[])
      : [];

    return (
      <svg
        className="absolute inset-0 pointer-events-none"
        width={imgSize.w}
        height={imgSize.h}
        style={{ top: 0, left: 0 }}
      >
        {fieldsToShow.map((field) => {
          const b = bboxes[field] as FieldBbox | undefined;
          if (!b) return null;
          const color = FIELD_COLORS[field] ?? '#6b7280';
          const x = b.x1 * imgSize.w;
          const y = (b.y1 + yOffset) * imgSize.h;
          const w = (b.x2 - b.x1) * imgSize.w;
          const h = (b.y2 - b.y1) * imgSize.h;
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
    <div className="relative w-full h-full overflow-auto bg-gray-100 flex items-start justify-center p-2">
      {isPdf ? (
        <iframe src={fileUrl} className="w-full h-full rounded" title="חשבונית" />
      ) : (
        <div className="relative inline-block">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {/* block מסיר את ה-baseline gap של inline images */}
          <img
            ref={imgRef}
            src={fileUrl}
            alt="חשבונית מקורית"
            className="block max-w-full h-auto rounded shadow-sm select-none"
            draggable={false}
          />
          {renderOverlay()}
        </div>
      )}
    </div>
  );
}
