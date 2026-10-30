'use client';

import { useState } from 'react';
import { Camera, Mail, Phone, User, FileText, Hash, MessageSquare, Check, Loader2 } from 'lucide-react';

type ScanType = 'photos' | 'documents' | 'invoices';

const scanTypeLabels: Record<ScanType, string> = {
  photos: 'תמונות ואלבומים',
  documents: 'מסמכים',
  invoices: 'חשבוניות וקבלות',
};

export default function OrderPage() {
  const [formData, setFormData] = useState({
    name: '',
    contact: '',
    scanTypes: [] as ScanType[],
    volume: '',
    notes: '',
  });
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState('');

  const toggleScanType = (type: ScanType) => {
    setFormData((prev) => ({
      ...prev,
      scanTypes: prev.scanTypes.includes(type)
        ? prev.scanTypes.filter((t) => t !== type)
        : [...prev.scanTypes, type],
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // Honeypot (hidden from people, filled by form bots) - see src/lib/leadGuard.ts
    const honeypot = (e.currentTarget as HTMLFormElement).elements.namedItem('website') as HTMLInputElement | null;
    setStatus('loading');
    setErrorMessage('');

    try {
      const res = await fetch('/api/lead', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: formData.name,
          contact: formData.contact,
          scanTypes: formData.scanTypes,
          volume: formData.volume,
          notes: formData.notes,
          website: honeypot?.value ?? '',
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'שגיאה בשליחת הטופס');
      }

      setStatus('success');
    } catch (err) {
      setStatus('error');
      setErrorMessage(err instanceof Error ? err.message : 'שגיאה בשליחת הטופס');
    }
  };

  if (status === 'success') {
    return (
      <div className="min-h-[60vh] flex items-center justify-center px-4">
        <div className="text-center max-w-md">
          <div className="w-16 h-16 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center mx-auto mb-6">
            <Check className="w-8 h-8" />
          </div>
          <h1 className="text-2xl font-bold text-stone-900 mb-3">
            קיבלנו את הפרטים!
          </h1>
          <p className="text-stone-600 mb-6">
            נחזור אליכם בהקדם עם הצעת מחיר מותאמת.
          </p>
          <a
            href="/"
            className="inline-flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-6 py-3 rounded-xl font-medium transition-colors"
          >
            חזרה לעמוד הבית
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="py-12 sm:py-16">
      <div className="max-w-2xl mx-auto px-4 sm:px-6">
        {/* Header */}
        <div className="text-center mb-10">
          <div className="inline-flex items-center gap-2 bg-blue-100 text-blue-700 px-4 py-1.5 rounded-full text-sm font-medium mb-4">
            <Mail className="w-4 h-4" />
            <span>בקשת הצעת מחיר</span>
          </div>
          <h1 className="text-3xl sm:text-4xl font-bold text-stone-900 mb-3">
            ספרו לנו מה יש לכם
          </h1>
          <p className="text-stone-600 text-lg">
            מלאו את הפרטים ונחזור אליכם עם הצעת מחיר
          </p>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="bg-white rounded-2xl border border-stone-200 shadow-sm p-6 sm:p-8 space-y-6">
          {/* Honeypot: invisible to people and screen readers, not focusable */}
          <div aria-hidden="true" style={{ position: 'absolute', left: '-10000px', width: 1, height: 1, overflow: 'hidden' }}>
            <label htmlFor="website">אתר</label>
            <input type="text" id="website" name="website" tabIndex={-1} autoComplete="off" defaultValue="" />
          </div>
          {/* Name */}
          <div>
            <label htmlFor="name" className="flex items-center gap-2 text-sm font-medium text-stone-700 mb-2">
              <User className="w-4 h-4 text-stone-400" />
              שם מלא
            </label>
            <input
              type="text"
              id="name"
              required
              maxLength={100}
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              className="w-full border border-stone-300 rounded-xl px-4 py-3 text-base bg-white placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors"
              placeholder="ישראל ישראלי"
            />
          </div>

          {/* Contact (phone or email) */}
          <div>
            <label htmlFor="contact" className="flex items-center gap-2 text-sm font-medium text-stone-700 mb-2">
              <Phone className="w-4 h-4 text-stone-400" />
              טלפון או אימייל
            </label>
            <input
              type="text"
              id="contact"
              required
              maxLength={200}
              value={formData.contact}
              onChange={(e) => setFormData({ ...formData, contact: e.target.value })}
              className="w-full border border-stone-300 rounded-xl px-4 py-3 text-base bg-white placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors"
              placeholder="050-1234567 או email@example.com"
            />
          </div>

          {/* What to scan */}
          <div>
            <label className="flex items-center gap-2 text-sm font-medium text-stone-700 mb-3">
              <Camera className="w-4 h-4 text-stone-400" />
              מה לסרוק?
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {(Object.keys(scanTypeLabels) as ScanType[]).map((type) => {
                const selected = formData.scanTypes.includes(type);
                return (
                  <button
                    key={type}
                    type="button"
                    onClick={() => toggleScanType(type)}
                    className={`flex items-center justify-center gap-2 px-4 py-3 rounded-xl border-2 text-sm font-medium transition-all ${
                      selected
                        ? 'border-blue-500 bg-blue-50 text-blue-700'
                        : 'border-stone-200 bg-white text-stone-600 hover:border-stone-300'
                    }`}
                  >
                    {selected && <Check className="w-4 h-4" />}
                    {scanTypeLabels[type]}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Volume */}
          <div>
            <label htmlFor="volume" className="flex items-center gap-2 text-sm font-medium text-stone-700 mb-2">
              <Hash className="w-4 h-4 text-stone-400" />
              כמות משוערת
            </label>
            <input
              type="text"
              id="volume"
              maxLength={100}
              value={formData.volume}
              onChange={(e) => setFormData({ ...formData, volume: e.target.value })}
              className="w-full border border-stone-300 rounded-xl px-4 py-3 text-base bg-white placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors"
              placeholder="למשל: 200 תמונות, 3 אלבומים, 50 מסמכים..."
            />
          </div>

          {/* Notes */}
          <div>
            <label htmlFor="notes" className="flex items-center gap-2 text-sm font-medium text-stone-700 mb-2">
              <MessageSquare className="w-4 h-4 text-stone-400" />
              הערות נוספות
            </label>
            <textarea
              id="notes"
              rows={4}
              maxLength={2000}
              value={formData.notes}
              onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
              className="w-full border border-stone-300 rounded-xl px-4 py-3 text-base bg-white placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors resize-none"
              placeholder="פרטים נוספים, דרישות מיוחדות, שאלות..."
            />
          </div>

          {/* Error message */}
          {status === 'error' && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-sm">
              {errorMessage}
            </div>
          )}

          {/* Submit */}
          <button
            type="submit"
            disabled={status === 'loading'}
            className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white px-6 py-4 rounded-xl text-lg font-semibold shadow-lg shadow-blue-600/25 hover:shadow-xl hover:shadow-blue-600/30 transition-all flex items-center justify-center gap-2"
          >
            {status === 'loading' ? (
              <>
                <Loader2 className="w-5 h-5 animate-spin" />
                שולח...
              </>
            ) : (
              <>
                <Mail className="w-5 h-5" />
                שליחת בקשה
              </>
            )}
          </button>
        </form>

        {/* Contact alternative */}
        <div className="mt-8 text-center">
          <p className="text-stone-500 text-sm mb-2">
            מעדיפים ליצור קשר ישירות?
          </p>
          <a
            href="mailto:contact@nadav-shtibel.com"
            className="text-blue-600 hover:text-blue-700 font-medium"
          >
            contact@nadav-shtibel.com
          </a>
        </div>
      </div>
    </div>
  );
}
