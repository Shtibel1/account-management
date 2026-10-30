'use client';

import { useSearchParams } from 'next/navigation';
import { UploadZone } from '@/components/UploadZone/UploadZone';
import { Suspense, useEffect, useState } from 'react';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { createClient } from '@/utils/supabase/client';

type ClientLookup =
  | { state: 'loading' }
  | { state: 'found'; name: string }
  | { state: 'missing' };

function NoClient({ title, text }: { title: string; text: string }) {
  return (
    <div className="card flex flex-col items-center justify-center py-24 text-center max-w-md mx-auto">
      <div className="bg-amber-50 rounded-full p-5 mb-4">
        <ArrowLeft className="h-8 w-8 text-amber-500" />
      </div>
      <h3 className="font-semibold text-slate-800 text-lg">{title}</h3>
      <p className="text-slate-500 text-sm mt-1 mb-5">{text}</p>
      <a
        href="/clients"
        className="bg-blue-600 hover:bg-blue-700 text-white px-5 py-2.5 rounded-xl text-sm font-semibold transition-colors shadow-sm"
      >
        עבור ללקוחות
      </a>
    </div>
  );
}

function UploadContent() {
  const params = useSearchParams();
  const clientId = params.get('clientId') ?? '';
  const [client, setClient] = useState<ClientLookup>({ state: 'loading' });

  // The client must exist and belong to the user's office (RLS) - otherwise nothing is uploaded
  useEffect(() => {
    if (!clientId) return;
    let cancelled = false;
    setClient({ state: 'loading' });
    createClient()
      .from('clients')
      .select('id, name')
      .eq('id', clientId)
      .limit(1)
      .then(({ data, error }: { data: { id: string; name: string }[] | null; error: unknown }) => {
        if (cancelled) return;
        const row = Array.isArray(data) ? data[0] : null;
        if (error || !row) setClient({ state: 'missing' });
        else setClient({ state: 'found', name: row.name });
      });
    return () => { cancelled = true; };
  }, [clientId]);

  if (!clientId) {
    return <NoClient title="יש לבחור לקוח תחילה" text="לא נבחר לקוח — עבור לרשימת הלקוחות ובחר לקוח להעלאה" />;
  }
  if (client.state === 'loading') {
    return (
      <div className="flex items-center justify-center py-24 text-slate-400">
        <Loader2 className="h-7 w-7 animate-spin" />
      </div>
    );
  }
  if (client.state === 'missing') {
    return <NoClient title="הלקוח לא נמצא" text="הלקוח שבקישור אינו קיים או אינו שייך למשרד שלך — בחר לקוח מהרשימה" />;
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-slate-900">העלאת חשבוניות · {client.name}</h2>
        <p className="text-sm text-slate-500 mt-1">גרור קבצים או לחץ לבחירה — PDF, JPG, PNG, WEBP · עד 20MB לקובץ</p>
      </div>
      <UploadZone clientId={clientId} />
    </div>
  );
}

export default function UploadPage() {
  return (
    <Suspense>
      <UploadContent />
    </Suspense>
  );
}
