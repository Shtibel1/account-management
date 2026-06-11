'use client';

import { useSearchParams } from 'next/navigation';
import { UploadZone } from '@/components/UploadZone/UploadZone';
import { Suspense } from 'react';
import { ArrowLeft } from 'lucide-react';

function UploadContent() {
  const params = useSearchParams();
  const clientId = params.get('clientId') ?? '';

  if (!clientId) {
    return (
      <div className="card flex flex-col items-center justify-center py-24 text-center max-w-md mx-auto">
        <div className="bg-amber-50 rounded-full p-5 mb-4">
          <ArrowLeft className="h-8 w-8 text-amber-500" />
        </div>
        <h3 className="font-semibold text-slate-800 text-lg">יש לבחור לקוח תחילה</h3>
        <p className="text-slate-500 text-sm mt-1 mb-5">לא נבחר לקוח — עבור לרשימת הלקוחות ובחר לקוח להעלאה</p>
        <a
          href="/clients"
          className="bg-blue-600 hover:bg-blue-700 text-white px-5 py-2.5 rounded-xl text-sm font-semibold transition-colors shadow-sm"
        >
          עבור ללקוחות
        </a>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-slate-900">העלאת חשבוניות</h2>
        <p className="text-sm text-slate-500 mt-1">גרור קבצים או לחץ לבחירה — PDF, JPG, PNG</p>
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
