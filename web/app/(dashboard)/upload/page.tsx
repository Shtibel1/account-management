'use client';

import { useSearchParams } from 'next/navigation';
import { UploadZone } from '@/components/UploadZone/UploadZone';
import { Suspense } from 'react';

function UploadContent() {
  const params = useSearchParams();
  const clientId = params.get('clientId') ?? '';

  if (!clientId) {
    return (
      <div className="text-center py-16 text-gray-500">
        <p>יש לבחור לקוח תחילה.</p>
        <a href="/clients" className="text-primary-600 hover:underline mt-2 inline-block">
          חזור לרשימת הלקוחות
        </a>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">העלאת חשבוניות</h1>
      <UploadZone clientId={clientId} />
      <p className="text-sm text-gray-500 text-center">
        לאחר ההעלאה, עבור ל
        <a href="/review" className="text-primary-600 hover:underline mx-1">בדיקה ואישור</a>
        לצפייה בחשבוניות שעובדו
      </p>
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
