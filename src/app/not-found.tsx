import type { Metadata } from 'next';
import Link from 'next/link';
import { FileQuestion } from 'lucide-react';

export const metadata: Metadata = { title: 'הדף לא נמצא' };

/** Hebrew 404 for every unknown route (replaces Next's default English page). */
export default function NotFound() {
  return (
    <main className="min-h-screen flex items-center justify-center bg-slate-100 px-4" dir="rtl">
      <div className="card max-w-md w-full p-8 text-center space-y-4">
        <div className="mx-auto h-14 w-14 rounded-2xl bg-blue-50 flex items-center justify-center">
          <FileQuestion className="h-7 w-7 text-blue-600" />
        </div>
        <p className="text-sm font-semibold text-blue-600">שגיאה 404</p>
        <h1 className="text-2xl font-bold text-slate-900">הדף לא נמצא</h1>
        <p className="text-sm text-slate-500">
          הכתובת שביקשת אינה קיימת או שהועברה. אפשר לחזור לרשימת הלקוחות ולהמשיך משם.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-2 pt-2">
          <Link
            href="/clients"
            className="bg-blue-600 hover:bg-blue-700 text-white px-5 py-2 rounded-xl text-sm font-semibold transition-colors"
          >
            ללקוחות המשרד
          </Link>
          <Link
            href="/"
            className="px-5 py-2 rounded-xl text-sm font-medium text-slate-600 hover:bg-slate-200 transition-colors"
          >
            לדף הבית
          </Link>
        </div>
      </div>
    </main>
  );
}
