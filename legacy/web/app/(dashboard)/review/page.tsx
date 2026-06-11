'use client';

import { useEffect, useRef, useState } from 'react';
import { createClient } from '@/utils/supabase/client';
import { Invoice } from '@invoice/shared-types';
import { InvoiceTable } from '@/components/InvoiceTable/InvoiceTable';
import { useToast } from '@/components/ui/Toast';
import { Loader2, RefreshCw } from 'lucide-react';

const STATUS_LABELS: Record<string, string> = {
  review:   'מוכן לבדיקה',
  approved: 'אושר',
  error:    'שגיאה בעיבוד',
};

export default function ReviewPage() {
  const supabase = createClient();
  const { toast } = useToast();
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const prevStatuses = useRef<Record<string, string>>({});

  const load = async (silent = false) => {
    if (!silent) setRefreshing(true);
    const { data } = await supabase
      .from('invoices')
      .select('*')
      .order('created_at', { ascending: false });
    setInvoices((data as Invoice[]) ?? []);
    setLoading(false);
    setRefreshing(false);
  };

  useEffect(() => {
    load(true);

    const channel = supabase
      .channel('invoices-status')
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'invoices' },
        (payload) => {
          const updated = payload.new as Invoice;
          const prev = prevStatuses.current[updated.id];

          if (prev && prev !== updated.status && STATUS_LABELS[updated.status]) {
            const label = STATUS_LABELS[updated.status];
            const type = updated.status === 'error' ? 'error' : 'success';
            toast(`${updated.file_name}: ${label}`, type);
          }

          prevStatuses.current[updated.id] = updated.status;
          setInvoices((prev) => prev.map((inv) => inv.id === updated.id ? updated : inv));
        }
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'invoices' },
        (payload) => {
          const inserted = payload.new as Invoice;
          prevStatuses.current[inserted.id] = inserted.status;
          setInvoices((prev) => [inserted, ...prev]);
        }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, []);

  useEffect(() => {
    invoices.forEach((inv) => {
      if (!prevStatuses.current[inv.id]) {
        prevStatuses.current[inv.id] = inv.status;
      }
    });
  }, [invoices]);

  return (
    <div className="space-y-6 max-w-6xl">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-slate-900">בדיקה ואישור</h2>
          <p className="text-sm text-slate-500 mt-1">
            {invoices.length > 0 ? `${invoices.length} חשבוניות במערכת` : 'אין חשבוניות עדיין'}
          </p>
        </div>
        <button
          onClick={() => load()}
          disabled={refreshing}
          className="flex items-center gap-2 text-sm text-slate-500 hover:text-slate-700 transition-colors px-3 py-1.5 rounded-lg hover:bg-slate-100"
        >
          <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
          רענן
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-24 text-slate-400">
          <Loader2 className="h-7 w-7 animate-spin" />
        </div>
      ) : (
        <InvoiceTable invoices={invoices} onExported={() => load()} />
      )}
    </div>
  );
}
