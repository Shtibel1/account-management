'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { createClient } from '@/utils/supabase/client';
import { Invoice } from '@invoice/shared-types';
import { ValidationForm } from '@/components/SplitPane/ValidationForm';
import { ImageViewer } from '@/components/SplitPane/ImageViewer';
import { ArrowRight, Loader2, Eye, EyeOff } from 'lucide-react';

export default function ReviewDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const supabase = createClient();
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeField, setActiveField] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [yOffset, setYOffset] = useState(0);

  const load = async () => {
    const { data } = await supabase.from('invoices').select('*').eq('id', id).single();
    setInvoice(data as Invoice);
    setLoading(false);
  };

  useEffect(() => { load(); }, [id]);

  const bboxes = invoice?.validated_data?.bboxes ?? invoice?.extracted_data?.bboxes;
  const hasBboxes = bboxes && Object.values(bboxes).some(Boolean);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-primary-500" />
      </div>
    );
  }

  if (!invoice) {
    return <div className="text-center py-16 text-gray-500">חשבונית לא נמצאה</div>;
  }

  return (
    <div className="flex flex-col h-[calc(100vh-80px)]">
      <div className="flex items-center gap-3 mb-4">
        <button onClick={() => router.back()} className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700">
          <ArrowRight className="h-4 w-4" /> חזור
        </button>
        <h1 className="text-lg font-semibold text-gray-900">בדיקת חשבונית</h1>

        {hasBboxes && (
          <div className="mr-auto flex items-center gap-3">
            {/* כיול אנכי — מוצג רק כשיש הדגשות פעילות */}
            {(showAll || activeField) && (
              <label className="flex items-center gap-2 text-xs text-gray-500">
                כיול ↕
                <input
                  type="range" min={-0.3} max={0.3} step={0.005}
                  value={yOffset}
                  onChange={(e) => setYOffset(parseFloat(e.target.value))}
                  className="w-28 accent-primary-600"
                />
                <span className="w-10 text-center font-mono text-gray-600">
                  {yOffset > 0 ? '+' : ''}{Math.round(yOffset * 100)}%
                </span>
                <button onClick={() => setYOffset(0)} className="text-gray-400 hover:text-gray-600 underline">
                  אפס
                </button>
              </label>
            )}
            <button
              onClick={() => setShowAll((v) => !v)}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full border transition-colors"
              style={{
                borderColor: showAll ? '#3b82f6' : '#d1d5db',
                background: showAll ? '#eff6ff' : 'white',
                color: showAll ? '#2563eb' : '#6b7280',
              }}
            >
              {showAll ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
              {showAll ? 'הסתר כל השדות' : 'הצג כל השדות'}
            </button>
          </div>
        )}
      </div>

      <div className="flex-1 grid grid-cols-2 gap-4 min-h-0">
        {/* צד שמאל — מסמך מקורי עם overlay */}
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden flex flex-col">
          <div className="p-3 border-b border-gray-200 bg-gray-50 text-sm font-medium text-gray-700 flex items-center justify-between">
            <span>מסמך מקורי</span>
            {hasBboxes && activeField && (
              <span className="text-xs text-primary-600 font-normal">
                מציג: {activeField.replace(/_/g, ' ')}
              </span>
            )}
          </div>
          <div className="flex-1 overflow-hidden">
            <ImageViewer
              fileUrl={invoice.file_url}
              bboxes={bboxes}
              activeField={activeField}
              showAll={showAll}
              yOffset={yOffset}
            />
          </div>
        </div>

        {/* צד ימין — טופס אימות */}
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <ValidationForm
            invoice={invoice}
            onApproved={load}
            onFieldFocus={hasBboxes ? setActiveField : undefined}
          />
        </div>
      </div>
    </div>
  );
}
