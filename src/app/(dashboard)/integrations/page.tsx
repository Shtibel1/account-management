'use client';

import { Suspense } from 'react';
import { Loader2, Users } from 'lucide-react';
import { IntegrationSettings } from '@/components/Integrations/IntegrationSettings';
import { ClientSelect, useSelectedClient } from '@/components/Integrations/ClientSelect';

function IntegrationsContent() {
  const { clients, loaded, clientId, setClientId } = useSelectedClient();

  return (
    <div className="space-y-6 max-w-6xl">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-slate-900">חיבור להנהלת חשבונות</h2>
          <p className="text-sm text-slate-500 mt-1">
            בחרו לאן ייוצאו החשבוניות המאושרות של הלקוח, הגדירו פרטי גישה ובדקו את החיבור. פרטי הגישה נשמרים מוצפנים.
          </p>
        </div>
        <ClientSelect clients={clients} value={clientId} onChange={setClientId} />
      </div>

      {!loaded ? (
        <div className="card flex items-center justify-center py-24 text-slate-400">
          <Loader2 className="h-7 w-7 animate-spin" />
        </div>
      ) : !clientId ? (
        <div className="card flex flex-col items-center justify-center py-20 text-center">
          <div className="bg-blue-50 rounded-full p-5 mb-4">
            <Users className="h-10 w-10 text-blue-500" />
          </div>
          <h3 className="font-semibold text-slate-800 text-lg">אין לקוחות עדיין</h3>
          <a href="/clients" className="text-blue-600 hover:underline text-sm mt-2">הוסיפו לקוח</a>
        </div>
      ) : (
        <IntegrationSettings key={clientId} clientId={clientId} />
      )}
    </div>
  );
}

export default function IntegrationsPage() {
  return (
    <Suspense>
      <IntegrationsContent />
    </Suspense>
  );
}
