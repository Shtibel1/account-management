'use client';

import { useEffect, useRef, useState } from 'react';
import { createClient } from '@/utils/supabase/client';
import { Invoice } from '@invoice/shared-types';
import { InvoiceTable } from '@/components/InvoiceTable/InvoiceTable';
import { useToast } from '@/components/ui/Toast';

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
  const prevStatuses = useRef<Record<string, string>>({});

  const load = async () => {
    const { data } = await supabase
      .from('invoices')
      .select('*')
      .order('created_at', { ascending: false });
    setInvoices((data as Invoice[]) ?? []);
    setLoading(false);
  };

  useEffect(() => {
    load();

    const channel = supabase
      .channel('invoices-status')
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'invoices' },
        (payload) => {
          const updated = payload.new as Invoice;
          const prev = prevStatuses.current[updated.id];

          // הצג toast רק כשסטטוס השתנה ממשהו ל-review/approved/error
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

  // שמור סטטוסים נוכחיים לצורך השוואה
  useEffect(() => {
    invoices.forEach((inv) => {
      if (!prevStatuses.current[inv.id]) {
        prevStatuses.current[inv.id] = inv.status;
      }
    });
  }, [invoices]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">בדיקה ואישור חשבוניות</h1>
        <button onClick={load} className="text-sm text-primary-600 hover:underline">רענן</button>
      </div>

      {loading ? (
        <div className="text-center py-16 text-gray-400">טוען...</div>
      ) : (
        <InvoiceTable invoices={invoices} onExported={load} />
      )}
    </div>
  );
}
