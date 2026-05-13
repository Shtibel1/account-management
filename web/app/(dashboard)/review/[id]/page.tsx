'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { createClient } from '@/utils/supabase/client';
import { Invoice } from '@invoice/shared-types';
import { ValidationForm } from '@/components/SplitPane/ValidationForm';
import { ImageViewer } from '@/components/SplitPane/ImageViewer';
import { ArrowRight, Loader2, Eye, EyeOff, SlidersHorizontal } from 'lucide-react';

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
      <div className="flex items-center justify-center h-64 text-slate-400">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    );
  }

  if (!invoice) {
    return (
      <div className="flex items-center justify-center h-64 text-slate-500">
        חשבונית לא נמצאה
      </div>
    );
  }

  return (
    <div className="flex flex-col h-[calc(100vh-80px)]">
      {/* Page header */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <button
          onClick={() => router.back()}
          className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-700 transition-colors"
        >
          <ArrowRight className="h-4 w-4" /> חזור
        </button>

        <span className="text-slate-300">·</span>
        <h1 className="text-base font-semibold text-slate-900 truncate max-w-xs">{invoice.file_name}</h1>

        {hasBboxes && (
          <div className="mr-auto flex items-center gap-3 flex-wrap">
            {(showAll || activeField) && (
              <label className="flex items-center gap-2 text-xs text-slate-500">
                <SlidersHorizontal className="h-3.5 w-3.5" />
                <input
                  type="range" min={-0.3} max={0.3} step={0.005}
                  value={yOffset}
                  onChange={(e) => setYOffset(parseFloat(e.target.value))}
                  className="w-24 accent-blue-600"
                />
                <span className="w-10 text-center font-mono text-slate-600 text-xs">
                  {yOffset > 0 ? '+' : ''}{Math.round(yOffset * 100)}%
                </span>
                <button onClick={() => setYOffset(0)} className="text-slate-400 hover:text-slate-600 underline text-xs">
                  אפס
                </button>
              </label>
            )}
            <button
              onClick={() => setShowAll((v) => !v)}
              className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full border transition-colors ${
                showAll
                  ? 'border-blue-300 bg-blue-50 text-blue-700'
                  : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300'
              }`}
            >
              {showAll ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
              {showAll ? 'הסתר שדות' : 'הצג כל השדות'}
            </button>
          </div>
        )}
      </div>

      {/* Split pane */}
      <div className="flex-1 grid grid-cols-2 gap-4 min-h-0">
        {/* Left — document viewer */}
        <div className="card overflow-hidden flex flex-col">
          <div className="px-4 py-3 border-b border-slate-100 bg-slate-50 text-sm font-medium text-slate-700 flex items-center justify-between">
            <span>מסמך מקורי</span>
            {hasBboxes && activeField && (
              <span className="text-xs text-blue-600 font-normal">
                {activeField.replace(/_/g, ' ')}
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

        {/* Right — validation form */}
        <div className="card overflow-hidden">
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
