'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { createClient } from '@/utils/supabase/client';
import { Invoice } from '@invoice/shared-types';
import { ValidationForm } from '@/components/SplitPane/ValidationForm';
import { ArrowRight, Loader2 } from 'lucide-react';

export default function ReviewDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const supabase = createClient();
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    const { data } = await supabase.from('invoices').select('*').eq('id', id).single();
    setInvoice(data as Invoice);
    setLoading(false);
  };

  useEffect(() => { load(); }, [id]);

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
      </div>

      <div className="flex-1 grid grid-cols-2 gap-4 min-h-0">
        {/* צד שמאל — מסמך מקורי */}
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="p-3 border-b border-gray-200 bg-gray-50 text-sm font-medium text-gray-700">
            מסמך מקורי
          </div>
          <div className="h-full overflow-auto p-2">
            {invoice.file_url.match(/\.pdf$/i) ? (
              <iframe
                src={invoice.file_url}
                className="w-full h-full rounded"
                title="חשבונית מקורית"
              />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={invoice.file_url}
                alt="חשבונית מקורית"
                className="w-full h-auto rounded object-contain"
              />
            )}
          </div>
        </div>

        {/* צד ימין — טופס אימות */}
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <ValidationForm invoice={invoice} onApproved={() => { load(); }} />
        </div>
      </div>
    </div>
  );
}
