'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Copy, ExternalLink, Loader2 } from 'lucide-react';
import type { DuplicateMatch, ValidationResult } from '@/shared/types';
import { DUPLICATE_REASON_LABELS } from '@/shared/duplicates';
import { StatusBadge } from '@/components/ui/Badge';
import { dismissDuplicate } from '@/lib/api';
import { useToast } from '@/components/ui/Toast';

interface Props {
  invoiceId: string;
  flags: ValidationResult | undefined;
  readOnly: boolean;
  onDismissed: (otherInvoiceId: string) => void;
}

function formatDate(date: string | null | undefined): string | null {
  if (!date) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : date;
}

function MatchDetails({ match }: { match: DuplicateMatch }) {
  const parts = [
    match.invoice_number ? `חשבונית ${match.invoice_number}` : null,
    formatDate(match.invoice_date),
    match.total_amount != null ? `₪${match.total_amount.toLocaleString()}` : null,
  ].filter(Boolean);
  return parts.length > 0 ? <span className="text-xs text-red-600/80">{parts.join(' · ')}</span> : null;
}

/** Suspected duplicates of this invoice, each with a link and a "not a duplicate" action. */
export function DuplicateAlert({ invoiceId, flags, readOnly, onDismissed }: Props) {
  const { toast } = useToast();
  const [dismissingId, setDismissingId] = useState<string | null>(null);

  const matches = flags?.duplicate_matches ?? [];
  // Results from before duplicate_matches existed only carry the boolean
  const legacyFlag = !!flags?.duplicate_found && matches.length === 0 && !flags?.duplicate_matches;
  if (matches.length === 0 && !legacyFlag) return null;

  const handleDismiss = async (otherInvoiceId: string) => {
    setDismissingId(otherInvoiceId);
    try {
      await dismissDuplicate(invoiceId, otherInvoiceId);
      onDismissed(otherInvoiceId);
      toast('סומן כלא כפול — הצמד הזה לא יסומן שוב', 'success');
    } catch (e) {
      console.error('[DuplicateAlert] Failed to dismiss duplicate:', e);
      toast(e instanceof Error ? e.message : 'שגיאה בסימון החשבונית כלא כפולה', 'error');
    } finally {
      setDismissingId(null);
    }
  };

  return (
    <div className="mx-4 mt-3 p-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700 space-y-2">
      <div className="flex items-center gap-2.5 font-semibold">
        <Copy className="h-4 w-4 shrink-0" />
        {legacyFlag ? 'חשד לחשבונית כפולה — כבר קיימת במערכת חשבונית עם אותו ספק ומספר' : 'חשד לחשבונית כפולה'}
      </div>

      {matches.map((match) => (
        <div
          key={match.invoice_id}
          className="flex items-center justify-between gap-3 flex-wrap bg-white/70 border border-red-100 rounded-lg px-3 py-2"
        >
          <div className="min-w-0 flex flex-col gap-0.5">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-red-100 text-red-700">
                {DUPLICATE_REASON_LABELS[match.reason]}
              </span>
              {match.status && <StatusBadge status={match.status} />}
            </div>
            <Link
              href={`/review/${match.invoice_id}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-red-800 font-medium hover:underline underline-offset-2 truncate"
            >
              <span className="truncate">{match.file_name || 'חשבונית קיימת'}</span>
              <ExternalLink className="h-3 w-3 shrink-0" />
            </Link>
            <MatchDetails match={match} />
          </div>

          {!readOnly && (
            <button
              type="button"
              onClick={() => handleDismiss(match.invoice_id)}
              disabled={dismissingId !== null}
              className="shrink-0 flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-red-200 bg-white text-red-700 font-semibold hover:bg-red-100 transition-colors disabled:opacity-60"
            >
              {dismissingId === match.invoice_id && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              לא כפולה
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
