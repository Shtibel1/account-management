'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { UploadZone } from '@/components/UploadZone/UploadZone';
import { Suspense, useEffect, useState } from 'react';
import { ArrowRightLeft, Loader2, Users } from 'lucide-react';
import { createClient } from '@/utils/supabase/client';
import { clientDisplayNames, type ClientLabelSource } from '@/shared/clientLabels';

type ClientLookup =
  | { state: 'loading' }
  | { state: 'found'; name: string }
  | { state: 'missing' };

/** No (valid) client in the URL: pick one right here instead of a dead end that sends you to /clients. */
function ClientPicker({ title, text }: { title: string; text: string }) {
  const router = useRouter();
  const [clients, setClients] = useState<ClientLabelSource[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    createClient()
      .from('clients')
      .select('id, name, vat_account, created_at')
      .is('archived_at', null)
      .order('name')
      .then(({ data, error }: { data: ClientLabelSource[] | null; error: unknown }) => {
        if (cancelled) return;
        if (error) setFailed(true);
        setClients(data ?? []);
      }, () => { if (!cancelled) { setFailed(true); setClients([]); } });
    return () => { cancelled = true; };
  }, []);

  const labels = clients ? clientDisplayNames(clients) : new Map<string, string>();

  return (
    <div className="card flex flex-col items-center justify-center py-16 px-6 text-center max-w-md mx-auto">
      <div className="bg-blue-50 rounded-full p-5 mb-4">
        <Users className="h-8 w-8 text-blue-500" aria-hidden="true" />
      </div>
      <h2 className="font-semibold text-slate-800 text-lg">{title}</h2>
      <p className="text-slate-500 text-sm mt-1 mb-5">{text}</p>
      {clients === null ? (
        <Loader2 className="h-6 w-6 animate-spin text-slate-400" aria-label="טוען לקוחות" />
      ) : clients.length > 0 ? (
        <div className="w-full text-right">
          <label htmlFor="upload-client" className="block text-sm font-medium text-slate-700 mb-1.5">לקוח</label>
          <select
            id="upload-client"
            className="input-base"
            defaultValue=""
            onChange={(e) => { if (e.target.value) router.push(`/upload?clientId=${encodeURIComponent(e.target.value)}`); }}
          >
            <option value="" disabled>בחרו לקוח...</option>
            {clients.map((c) => <option key={c.id} value={c.id}>{labels.get(c.id) ?? c.name}</option>)}
          </select>
        </div>
      ) : (
        <>
          {failed && <p className="text-sm text-red-600 mb-3">טעינת הלקוחות נכשלה. רעננו את הדף ונסו שוב.</p>}
          <Link
            href="/clients"
            className="bg-blue-600 hover:bg-blue-700 text-white px-5 py-2.5 min-h-[44px] inline-flex items-center rounded-xl text-sm font-semibold transition-colors shadow-sm"
          >
            {failed ? 'מעבר לרשימת הלקוחות' : 'הוספת לקוח ראשון'}
          </Link>
        </>
      )}
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
      }, () => {
        // network failure: don't leave the page spinning forever
        if (!cancelled) setClient({ state: 'missing' });
      });
    return () => { cancelled = true; };
  }, [clientId]);

  if (!clientId) {
    return <ClientPicker title="לאיזה לקוח שייכות החשבוניות?" text="בחרו לקוח כדי להעלות עבורו חשבוניות" />;
  }
  if (client.state === 'loading') {
    return (
      <div className="flex items-center justify-center py-24 text-slate-400">
        <Loader2 className="h-7 w-7 animate-spin" aria-label="טוען" />
      </div>
    );
  }
  if (client.state === 'missing') {
    return <ClientPicker title="הלקוח לא נמצא" text="הלקוח שבקישור אינו קיים או אינו שייך למשרד שלך. בחרו לקוח מהרשימה" />;
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h2 className="text-2xl font-bold text-slate-900">העלאת חשבוניות · <bdi>{client.name}</bdi></h2>
          <p className="text-sm text-slate-500 mt-1">גררו קבצים או לחצו לבחירה. PDF, JPG, PNG, WEBP · עד 20MB לקובץ</p>
        </div>
        <Link
          href="/upload"
          className="inline-flex items-center gap-1.5 text-sm text-blue-600 hover:text-blue-700 font-medium min-h-[44px] px-1"
        >
          <ArrowRightLeft className="h-4 w-4" aria-hidden="true" />
          החלפת לקוח
        </Link>
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
