'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import { createClient } from '@/utils/supabase/client';
import { Invoice } from '@/shared/types';
import { ValidationForm } from '@/components/SplitPane/ValidationForm';
import { ArrowRight, Loader2, Eye, EyeOff, SlidersHorizontal, Scissors, Sparkles } from 'lucide-react';
import { splitInvoice } from '@/lib/api';
import { formatRangesForInput, usableSuggestion } from '@/shared/documentSplit';
import { useToast } from '@/components/ui/Toast';
import { useFeatureFlags } from '@/components/FeatureFlags/useFeatureFlags';
import { ReturnToClientDialog } from '@/components/ReviewLoop/ReturnToClientDialog';
import { ReturnedNotice } from '@/components/ReviewLoop/ReturnedNotice';
import { canReturnInvoice } from '@/shared/returns';
import { ProcessingBanner } from '@/components/Processing/ProcessingStatus';

const ImageViewer = dynamic(() => import('@/components/SplitPane/ImageViewer').then((m) => m.ImageViewer), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center h-full text-slate-400">
      טוען מציג מסמכים...
    </div>
  ),
});

interface SplitRange {
  startPage: number;
  endPage: number;
}

function parsePageRanges(input: string, totalPages: number): { ranges: SplitRange[] | null; error: string | null } {
  const clean = input.replace(/\s+/g, '');
  if (!clean) return { ranges: null, error: 'אנא הזן טווחי עמודים' };
  
  const parts = clean.split(',');
  const ranges: SplitRange[] = [];
  const coveredPages = new Set<number>();

  for (const part of parts) {
    if (!part) continue;
    
    const matchSingle = /^\d+$/.test(part);
    const matchRange = /^(\d+)-(\d+)$/.test(part);
    
    if (!matchSingle && !matchRange) {
      return { ranges: null, error: `פורמט לא תקין: "${part}" (השתמש במספרים או טווחים כמו 1-3)` };
    }
    
    let start = 0;
    let end = 0;
    
    if (matchSingle) {
      start = parseInt(part, 10);
      end = start;
    } else {
      const match = part.match(/^(\d+)-(\d+)$/);
      if (!match) return { ranges: null, error: `שגיאה בפענוח: ${part}` };
      start = parseInt(match[1], 10);
      end = parseInt(match[2], 10);
    }
    
    if (start < 1 || start > totalPages || end < 1 || end > totalPages) {
      return { ranges: null, error: `מספרי עמודים חייבים להיות בין 1 ל- ${totalPages}` };
    }
    
    if (start > end) {
      return { ranges: null, error: `עמוד התחלה (${start}) גדול מעמוד סיום (${end})` };
    }
    
    for (let p = start; p <= end; p++) {
      if (coveredPages.has(p)) {
        return { ranges: null, error: `עמוד ${p} מופיע ביותר מטווח אחד` };
      }
      coveredPages.add(p);
    }
    
    ranges.push({ startPage: start, endPage: end });
  }

  // Check if all pages are covered
  const missing: number[] = [];
  for (let p = 1; p <= totalPages; p++) {
    if (!coveredPages.has(p)) {
      missing.push(p);
    }
  }

  if (missing.length > 0) {
    return { ranges: null, error: `חסרים העמודים הבאים בפיצול: ${missing.join(', ')}` };
  }

  // Sort ranges by startPage for visual order
  ranges.sort((a, b) => a.startPage - b.startPage);

  return { ranges, error: null };
}

export default function ReviewDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const supabase = createClient();
  const { toast } = useToast();

  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeField, setActiveField] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [yOffset, setYOffset] = useState(0);

  // Manual split states
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [showSplitModal, setShowSplitModal] = useState(false);
  const [splitMode, setSplitMode] = useState<'all' | 'custom'>('all');
  const [customRanges, setCustomRanges] = useState('');
  const [splitLoading, setSplitLoading] = useState(false);
  const [parsedRanges, setParsedRanges] = useState<SplitRange[] | null>(null);
  const [rangeError, setRangeError] = useState<string | null>(null);

  // Automatic split suggestion (set by the pipeline when the file looks like several documents)
  const [suggestionDismissed, setSuggestionDismissed] = useState(false);
  const [prefilledFromSuggestion, setPrefilledFromSuggestion] = useState(false);

  // Accountant review loop ("החזר ללקוח"), behind the office's feature flag
  const { isEnabled: isFlagEnabled } = useFeatureFlags({ clientId: invoice?.client_id ?? null });
  const reviewLoop = !!invoice?.client_id && isFlagEnabled('accountant_review_loop');
  const [showReturnDialog, setShowReturnDialog] = useState(false);

  const load = async () => {
    const { data } = await supabase.from('invoices').select('*').eq('id', id).single();
    setInvoice(data as Invoice);
    setLoading(false);
  };

  useEffect(() => { load(); }, [id]);

  useEffect(() => {
    if (invoice && invoice.file_url && invoice.file_url.toLowerCase().includes('.pdf')) {
      // Dynamic import of pdf-lib to get page count on the client
      import('pdf-lib').then(async ({ PDFDocument }) => {
        try {
          const res = await fetch(invoice.file_url);
          const buf = await res.arrayBuffer();
          const doc = await PDFDocument.load(buf, { ignoreEncryption: true });
          setPageCount(doc.getPageCount());
        } catch (e) {
          console.error('[ReviewDetail] Failed to get PDF page count:', e);
        }
      });
    }
  }, [invoice]);

  // Update parsed ranges preview when input changes
  useEffect(() => {
    if (splitMode === 'custom' && pageCount) {
      const { ranges, error } = parsePageRanges(customRanges, pageCount);
      setParsedRanges(ranges);
      setRangeError(error);
    } else {
      setParsedRanges(null);
      setRangeError(null);
    }
  }, [customRanges, splitMode, pageCount]);

  // Only once the real page count is known, and only if the suggestion still fits this file
  const splitSuggestion = pageCount
    ? usableSuggestion(invoice?.extracted_data?.split_suggestion, pageCount)
    : null;

  const openSplitModal = () => {
    // Pre-fill the custom ranges with the detected split unless the reviewer already typed ranges
    if (splitSuggestion && !customRanges.trim()) {
      setSplitMode('custom');
      setCustomRanges(formatRangesForInput(splitSuggestion.documents));
      setPrefilledFromSuggestion(true);
    }
    setShowSplitModal(true);
  };

  const handlePerformSplit = async () => {
    if (!invoice || !pageCount) return;

    let finalSplits: SplitRange[] = [];
    if (splitMode === 'all') {
      for (let p = 1; p <= pageCount; p++) {
        finalSplits.push({ startPage: p, endPage: p });
      }
    } else {
      const { ranges, error } = parsePageRanges(customRanges, pageCount);
      if (error || !ranges) {
        toast(error || 'טווחי עמודים לא תקינים', 'error');
        return;
      }
      finalSplits = ranges;
    }

    setSplitLoading(true);
    try {
      const result = await splitInvoice(invoice.id, finalSplits, invoice.client_id);
      toast(result?.warning || 'הקובץ פוצל בהצלחה. תהליך ה-AI הופעל מחדש עבור כל חלק.', result?.warning ? 'info' : 'success');
      setShowSplitModal(false);
      router.push('/review');
    } catch (e: any) {
      console.error(e);
      toast(e.message || 'שגיאה בביצוע הפיצול', 'error');
    } finally {
      setSplitLoading(false);
    }
  };

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

      {reviewLoop && <ReturnedNotice invoice={invoice} />}

      <ProcessingBanner invoice={invoice} onChanged={load} />

      {/* Automatic split suggestion */}
      {splitSuggestion && !suggestionDismissed && (
        <div className="mb-4 flex items-start gap-3 p-3 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-800">
          <Scissors className="h-4 w-4 mt-0.5 shrink-0 text-amber-500" />
          <div className="flex-1 min-w-0 space-y-1.5">
            <p className="font-semibold text-amber-900">
              נראה שהקובץ מכיל {splitSuggestion.documents.length} מסמכים נפרדים
              <span className="font-normal text-amber-700"> · ביטחון {Math.round(splitSuggestion.confidence * 100)}%</span>
            </p>
            <div className="flex flex-wrap gap-1.5 text-xs">
              {splitSuggestion.documents.map((doc, idx) => (
                <span
                  key={doc.start_page}
                  title={doc.reason ?? undefined}
                  className="px-2 py-0.5 rounded-lg bg-white border border-amber-200 text-amber-800"
                >
                  חלק {idx + 1}:{' '}
                  {doc.start_page === doc.end_page ? `עמוד ${doc.start_page}` : `עמודים ${doc.start_page}-${doc.end_page}`}
                  {doc.reason && <span className="text-amber-600"> · {doc.reason}</span>}
                </span>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={openSplitModal}
              className="text-xs px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-700 text-white font-semibold transition-colors"
            >
              בדוק ופצל
            </button>
            <button
              onClick={() => setSuggestionDismissed(true)}
              className="text-xs px-2 py-1.5 text-amber-700 hover:text-amber-900 underline"
            >
              התעלם
            </button>
          </div>
        </div>
      )}

      {/* Split pane */}
      <div className="flex-1 grid grid-cols-2 gap-4 min-h-0">
        {/* Right — validation form (places it on the right side in RTL) */}
        <div className="card overflow-hidden">
          <ValidationForm
            invoice={invoice}
            onApproved={load}
            onFieldFocus={hasBboxes ? setActiveField : undefined}
            onReturnToClient={reviewLoop && canReturnInvoice(invoice.status) ? () => setShowReturnDialog(true) : undefined}
          />
        </div>

        {/* Left — document viewer (places it on the left side in RTL) */}
        <div className="card overflow-hidden flex flex-col">
          <div className="px-4 py-3 border-b border-slate-100 bg-slate-50 text-sm font-medium text-slate-700 flex items-center justify-between">
            <span>מסמך מקורי</span>
            {pageCount && pageCount > 1 && (
              <button
                onClick={openSplitModal}
                className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg bg-blue-50 text-blue-600 border border-blue-200 hover:bg-blue-100 hover:text-blue-700 transition-colors font-semibold shadow-sm"
              >
                <Scissors className="h-3.5 w-3.5" /> פיצול מסמך ({pageCount} עמודים)
              </button>
            )}
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
      </div>

      {showReturnDialog && (
        <ReturnToClientDialog
          invoiceId={invoice.id}
          fileName={invoice.file_name}
          onClose={() => setShowReturnDialog(false)}
          onReturned={load}
        />
      )}

      {/* Split Modal */}
      {showSplitModal && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-50 flex items-center justify-center p-4" style={{ direction: 'rtl' }}>
          <div className="bg-white rounded-2xl border border-slate-100 shadow-xl max-w-md w-full p-6 space-y-4 text-right">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <h3 className="text-lg font-bold text-slate-900 flex items-center gap-2">
                <Scissors className="h-5 w-5 text-blue-600" />
                פיצול מסמך PDF
              </h3>
              <button
                onClick={() => setShowSplitModal(false)}
                className="text-slate-400 hover:text-slate-600 transition-colors text-lg font-bold"
              >
                ✕
              </button>
            </div>

            <div className="text-sm text-slate-500">
              מסמך זה מכיל <span className="font-semibold text-slate-700">{pageCount}</span> עמודים. באפשרותך לפצל אותו למספר חשבוניות נפרדות שיעובדו עצמאית.
            </div>

            <div className="space-y-3 pt-2">
              <label className="flex items-center gap-3 cursor-pointer p-3 rounded-xl border border-slate-200 hover:bg-slate-50 transition-colors">
                <input
                  type="radio"
                  name="splitMode"
                  checked={splitMode === 'all'}
                  onChange={() => setSplitMode('all')}
                  className="h-4 w-4 text-blue-600"
                />
                <div>
                  <p className="text-sm font-semibold text-slate-800">פצל כל עמוד לחשבונית נפרדת</p>
                  <p className="text-xs text-slate-400">ייווצרו {pageCount} חשבוניות נפרדות (עמוד 1, עמוד 2, וכו')</p>
                </div>
              </label>

              <label className="flex items-center gap-3 cursor-pointer p-3 rounded-xl border border-slate-200 hover:bg-slate-50 transition-colors">
                <input
                  type="radio"
                  name="splitMode"
                  checked={splitMode === 'custom'}
                  onChange={() => setSplitMode('custom')}
                  className="h-4 w-4 text-blue-600"
                />
                <div className="flex-1">
                  <p className="text-sm font-semibold text-slate-800">פיצול לפי טווחי עמודים מותאמים אישית</p>
                  <p className="text-xs text-slate-400">הגדר טווחים מותאמים אישית (למשל, עמודים 1-2 ביחד)</p>
                </div>
              </label>
            </div>

            {splitMode === 'custom' && (
              <div className="space-y-2 pt-2 animate-in fade-in slide-in-from-top-1 duration-200">
                {prefilledFromSuggestion && splitSuggestion && (
                  <p className="flex items-start gap-2 text-xs text-blue-700 bg-blue-50 border border-blue-200 rounded-xl p-2.5">
                    <Sparkles className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                    <span>
                      הטווחים מולאו מראש לפי זיהוי אוטומטי (ביטחון {Math.round(splitSuggestion.confidence * 100)}%). בדוק אותם מול המסמך ותקן במידת הצורך לפני הפיצול.
                    </span>
                  </p>
                )}
                <label className="block text-xs font-semibold text-slate-500">
                  הזן טווחים מופרדים בפסיקים (לדוגמה: 1-2, 3, 4-{pageCount}):
                </label>
                <input
                  type="text"
                  value={customRanges}
                  onChange={(e) => setCustomRanges(e.target.value)}
                  placeholder={`1-2, 3, 4-${pageCount}`}
                  className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 text-left ltr"
                  style={{ direction: 'ltr' }}
                />

                {rangeError ? (
                  <p className="text-xs text-rose-500 font-medium">{rangeError}</p>
                ) : parsedRanges ? (
                  <div className="bg-slate-50 rounded-xl p-3 space-y-1.5 border border-slate-100">
                    <p className="text-xs font-semibold text-slate-400">תצוגה מקדימה של הפיצול:</p>
                    <div className="grid grid-cols-2 gap-2 text-xs font-medium text-slate-600">
                      {parsedRanges.map((range, idx) => (
                        <div key={idx} className="bg-white px-2 py-1 rounded border border-slate-200/50 flex items-center justify-between">
                          <span>חלק {idx + 1}:</span>
                          <span className="text-blue-600 font-semibold">
                            {range.startPage === range.endPage ? `עמוד ${range.startPage}` : `עמודים ${range.startPage}-${range.endPage}`}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            )}

            <div className="flex items-center gap-3 pt-4 border-t border-slate-100 justify-end">
              <button
                onClick={() => setShowSplitModal(false)}
                disabled={splitLoading}
                className="px-4 py-2 border border-slate-200 hover:bg-slate-50 text-slate-500 text-sm font-semibold rounded-xl transition-colors disabled:opacity-50"
              >
                ביטול
              </button>
              <button
                onClick={handlePerformSplit}
                disabled={splitLoading || (splitMode === 'custom' && (!parsedRanges || !!rangeError))}
                className="px-5 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold rounded-xl shadow-sm transition-colors disabled:opacity-60 flex items-center gap-2"
              >
                {splitLoading ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    מפצל...
                  </>
                ) : (
                  'בצע פיצול ועיבוד מחדש'
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
