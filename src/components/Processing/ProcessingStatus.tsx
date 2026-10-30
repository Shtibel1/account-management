'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2, RotateCcw } from 'lucide-react';
import type { Invoice } from '@/shared/types';
import { reprocessInvoice, tickProcessing } from '@/lib/api';
import { describeProgress } from '@/shared/processing';
import { useToast } from '@/components/ui/Toast';

/** How often a screen advances the queued runs of the invoices it shows as processing. */
const TICK_INTERVAL_MS = 5_000;
/** Invoices advanced per interval (the scheduled worker handles the rest too). */
const MAX_TICKS_PER_INTERVAL = 3;

/**
 * Keeps the processing queue moving while invoices are shown as 'processing' (finding #6): every few
 * seconds it asks the server to run one bounded step for a few of them. Ticks are safe to repeat and
 * to run concurrently (the server locks the job), and a stuck run is turned into an error by the
 * tick itself. `onSettled` runs when one of them left 'processing' (to reload the data).
 */
export function useProcessingTicks(
  invoices: Pick<Invoice, 'id' | 'status'>[],
  onSettled?: (invoiceId: string) => void
): void {
  const processingIds = invoices.filter((i) => i.status === 'processing').map((i) => i.id);
  const key = processingIds.join(',');
  const settledRef = useRef(onSettled);
  settledRef.current = onSettled;
  const cursor = useRef(0);

  useEffect(() => {
    if (!key) return;
    const ids = key.split(',');
    let stopped = false;
    let running = false;

    const run = async () => {
      if (running || stopped) return;
      running = true;
      try {
        const batch: string[] = [];
        for (let i = 0; i < Math.min(MAX_TICKS_PER_INTERVAL, ids.length); i++) {
          batch.push(ids[(cursor.current + i) % ids.length]);
        }
        cursor.current = (cursor.current + batch.length) % ids.length;
        const results = await Promise.all(batch.map((id) => tickProcessing(id).then((r) => ({ id, r }))));
        if (stopped) return;
        for (const { id, r } of results) {
          if (r && (r.state === 'done' || r.state === 'failed')) settledRef.current?.(id);
        }
      } finally {
        running = false;
      }
    };

    void run();
    const timer = setInterval(run, TICK_INTERVAL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [key]);
}

/** "מזהה טקסט (OCR) · 10/22 עמודים" for an invoice in processing. */
export function processingLabel(invoice: Pick<Invoice, 'processing_stage' | 'processing_progress'>): string {
  return describeProgress(invoice.processing_stage, invoice.processing_progress);
}

/**
 * Review screen banner: progress while the invoice is processing, and a "עבד מחדש" action for
 * invoices in review / error (approved ones only after an explicit confirmation; exported never).
 */
export function ProcessingBanner({ invoice, onChanged }: { invoice: Invoice; onChanged: () => void }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  useProcessingTicks([invoice], () => onChanged());

  if (invoice.status === 'processing') {
    return (
      <div className="mb-4 flex items-center gap-3 p-3 bg-blue-50 border border-blue-200 rounded-xl text-sm text-blue-800">
        <Loader2 className="h-4 w-4 animate-spin shrink-0 text-blue-500" />
        <span className="font-medium">{processingLabel(invoice)}</span>
        <span className="text-blue-600 text-xs">העיבוד ממשיך ברקע - אפשר לעזוב את המסך</span>
      </div>
    );
  }

  const canReprocess = invoice.status === 'review' || invoice.status === 'error' || invoice.status === 'approved';
  if (!canReprocess) return null;

  const handleReprocess = async () => {
    const reopen = invoice.status === 'approved';
    if (reopen && !window.confirm('החשבונית כבר אושרה. לפתוח אותה מחדש ולהריץ שוב את הניתוח? הערכים שאושרו יישמרו, והחשבונית תחזור לבדיקה.')) {
      return;
    }
    setBusy(true);
    try {
      await reprocessInvoice(invoice.id, { reopen });
      toast('העיבוד מחדש הופעל', 'success');
      onChanged();
    } catch (e: any) {
      toast(e?.message || 'לא ניתן היה להפעיל עיבוד מחדש', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mb-2 flex justify-end">
      <button
        onClick={handleReprocess}
        disabled={busy}
        className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-60"
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
        עבד מחדש
      </button>
    </div>
  );
}
