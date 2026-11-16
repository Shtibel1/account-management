'use client';

import { Suspense, useMemo } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { IntegrationLogs, type LogFilterState } from '@/components/Integrations/IntegrationLogs';
import { ClientSelect, useSelectedClient } from '@/components/Integrations/ClientSelect';

const FILTER_KEYS = ['pluginId', 'outcome', 'invoiceId', 'correlationId'] as const;

function LogsContent() {
  const { clients, loaded, clientId, setClientId } = useSelectedClient();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const pluginId = params.get('pluginId') ?? '';
  const outcome = params.get('outcome') ?? '';
  const invoiceId = params.get('invoiceId') ?? '';
  const correlationId = params.get('correlationId') ?? '';
  // Stable per URL so the table only reloads when a filter actually changes.
  const filters = useMemo<LogFilterState>(
    () => ({ pluginId, outcome, invoiceId, correlationId }),
    [pluginId, outcome, invoiceId, correlationId]
  );

  const setFilters = (next: LogFilterState) => {
    const q = new URLSearchParams(params.toString());
    if (clientId) q.set('clientId', clientId);
    for (const key of FILTER_KEYS) {
      if (next[key]) q.set(key, next[key]);
      else q.delete(key);
    }
    router.replace(`${pathname}?${q.toString()}`);
  };

  return (
    <div className="space-y-6 max-w-7xl">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-slate-900">יומן אינטגרציות</h2>
          <p className="text-sm text-slate-500 mt-1">כל קריאה למערכות הנהלת החשבונות: בקשה, תשובה, משך, ניסיונות חוזרים ושגיאות.</p>
        </div>
        <ClientSelect clients={clients} value={clientId} onChange={setClientId} />
      </div>
      {!loaded ? (
        <div className="card flex items-center justify-center py-24 text-slate-400"><Loader2 className="h-7 w-7 animate-spin" /></div>
      ) : !clientId ? (
        <div className="card p-10 text-center text-slate-500 text-sm">אין לקוחות עדיין</div>
      ) : (
        <IntegrationLogs
          key={clientId}
          clientId={clientId}
          filters={filters}
          onFiltersChange={setFilters}
        />
      )}
    </div>
  );
}

export default function IntegrationLogsPage() {
  return (
    <Suspense>
      <LogsContent />
    </Suspense>
  );
}
