'use client';

import { useState } from 'react';
import { ExtractedData, Invoice } from '@invoice/shared-types';
import { Button } from '@/components/ui/Button';
import { approveInvoice } from '@/lib/api';
import clsx from 'clsx';
import { AlertCircle, CheckCircle } from 'lucide-react';

const EXPENSE_CATEGORIES = [
  'ציוד משרדי', 'שכ"ד', 'תקשורת', 'שיווק ופרסום',
  'נסיעות', 'אחזקה', 'שירותים מקצועיים', 'חשמל ומים', 'אחר',
];

interface Props {
  invoice: Invoice;
  onApproved: () => void;
  onFieldFocus?: (field: string | null) => void;
}

export function ValidationForm({ invoice, onApproved, onFieldFocus }: Props) {
  const initial = invoice.validated_data ?? invoice.extracted_data;
  const [data, setData] = useState<Partial<ExtractedData>>(initial ?? {});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const flags = initial?.validation_flags;
  const mathOk = flags?.math_ok ?? true;
  const warnings = flags?.warnings ?? [];

  const set = (key: keyof ExtractedData, value: any) =>
    setData((prev) => ({ ...prev, [key]: value }));

  const fieldError = (key: string) =>
    flags?.fields_missing?.includes(key) ?? false;

  const mathError =
    data.amount_before_vat != null && data.vat_amount != null && data.total_amount != null &&
    Math.abs((data.amount_before_vat + data.vat_amount) - data.total_amount) > 1;

  const handleApprove = async () => {
    setSaving(true); setError('');
    try {
      await approveInvoice(invoice.id, data);
      onApproved();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const inputClass = (hasError: boolean) => clsx(
    'w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2',
    hasError
      ? 'border-red-400 bg-red-50 focus:ring-red-400'
      : 'border-gray-300 focus:ring-primary-500'
  );

  return (
    <div className="h-full flex flex-col">
      <div className="p-4 border-b border-gray-200 bg-white">
        <h2 className="font-semibold text-gray-900">{invoice.file_name}</h2>
        {invoice.ai_confidence != null && (
          <p className="text-xs text-gray-500 mt-0.5">
            רמת ביטחון AI: {Math.round(invoice.ai_confidence * 100)}%
          </p>
        )}
      </div>

      {!mathOk && (
        <div className="mx-4 mt-4 flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          <AlertCircle className="h-4 w-4 shrink-0" />
          סכומים לא מסתדרים — בדוק את הנתונים מול המסמך
        </div>
      )}
      {warnings.map((w, i) => (
        <div key={i} className="mx-4 mt-2 flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-800">
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          {w}
        </div>
      ))}

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        <Field label="שם ספק" error={fieldError('supplier_name')} fieldKey="supplier_name" onFieldFocus={onFieldFocus}>
          <input className={inputClass(fieldError('supplier_name'))} value={data.supplier_name ?? ''} onChange={(e) => set('supplier_name', e.target.value)} onFocus={() => onFieldFocus?.('supplier_name')} onBlur={() => onFieldFocus?.(null)} />
        </Field>

        <Field label="ח.פ. / עוסק מורשה" error={fieldError('supplier_vat_id') || !(flags?.vat_id_ok ?? true)} fieldKey="supplier_vat_id" onFieldFocus={onFieldFocus}>
          <input className={inputClass(fieldError('supplier_vat_id') || !(flags?.vat_id_ok ?? true))} value={data.supplier_vat_id ?? ''} onChange={(e) => set('supplier_vat_id', e.target.value)} onFocus={() => onFieldFocus?.('supplier_vat_id')} onBlur={() => onFieldFocus?.(null)} />
          {!(flags?.vat_id_ok ?? true) && <p className="text-xs text-red-600 mt-1">מספר עוסק לא תקין (חייב להיות 9 ספרות)</p>}
        </Field>

        <Field label="מספר חשבונית" error={fieldError('invoice_number')} fieldKey="invoice_number" onFieldFocus={onFieldFocus}>
          <input className={inputClass(fieldError('invoice_number'))} value={data.invoice_number ?? ''} onChange={(e) => set('invoice_number', e.target.value)} onFocus={() => onFieldFocus?.('invoice_number')} onBlur={() => onFieldFocus?.(null)} />
        </Field>

        <Field label="תאריך חשבונית" error={fieldError('invoice_date')} fieldKey="invoice_date" onFieldFocus={onFieldFocus}>
          <input type="date" className={inputClass(fieldError('invoice_date'))} value={data.invoice_date ?? ''} onChange={(e) => set('invoice_date', e.target.value)} onFocus={() => onFieldFocus?.('invoice_date')} onBlur={() => onFieldFocus?.(null)} />
        </Field>

        <div className="grid grid-cols-3 gap-3">
          <Field label="לפני מע״מ" error={mathError} fieldKey="amount_before_vat" onFieldFocus={onFieldFocus}>
            <input type="number" step="0.01" className={inputClass(mathError)} value={data.amount_before_vat ?? ''} onChange={(e) => set('amount_before_vat', parseFloat(e.target.value))} onFocus={() => onFieldFocus?.('amount_before_vat')} onBlur={() => onFieldFocus?.(null)} />
          </Field>
          <Field label='מע"מ' error={mathError} fieldKey="vat_amount" onFieldFocus={onFieldFocus}>
            <input type="number" step="0.01" className={inputClass(mathError)} value={data.vat_amount ?? ''} onChange={(e) => set('vat_amount', parseFloat(e.target.value))} onFocus={() => onFieldFocus?.('vat_amount')} onBlur={() => onFieldFocus?.(null)} />
          </Field>
          <Field label="סה״כ לתשלום" error={mathError} fieldKey="total_amount" onFieldFocus={onFieldFocus}>
            <input type="number" step="0.01" className={inputClass(mathError)} value={data.total_amount ?? ''} onChange={(e) => set('total_amount', parseFloat(e.target.value))} onFocus={() => onFieldFocus?.('total_amount')} onBlur={() => onFieldFocus?.(null)} />
          </Field>
        </div>
        {mathError && (
          <p className="text-xs text-red-600">שגיאה חשבונית: לפני מע"מ + מע"מ ≠ סה"כ</p>
        )}

        <Field label="קטגוריית הוצאה" error={fieldError('expense_category')} fieldKey="expense_category" onFieldFocus={onFieldFocus}>
          <select className={inputClass(fieldError('expense_category'))} value={data.expense_category ?? ''} onChange={(e) => set('expense_category', e.target.value)} onFocus={() => onFieldFocus?.('expense_category')} onBlur={() => onFieldFocus?.(null)}>
            <option value="">בחר קטגוריה...</option>
            {EXPENSE_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </Field>
      </div>

      <div className="p-4 border-t border-gray-200 bg-white">
        {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
        <div className="flex items-center gap-3">
          <Button onClick={handleApprove} disabled={saving || mathError || invoice.status === 'approved'} className="flex-1">
            {invoice.status === 'approved' ? (
              <><CheckCircle className="h-4 w-4 ml-1" />אושר</>
            ) : saving ? 'שומר...' : 'אשר חשבונית'}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, error, fieldKey, onFieldFocus, children }: {
  label: string; error: boolean;
  fieldKey?: string;
  onFieldFocus?: (field: string | null) => void;
  children: React.ReactNode;
}) {
  return (
    <div
      onMouseEnter={() => fieldKey && onFieldFocus?.(fieldKey)}
      onMouseLeave={() => onFieldFocus?.(null)}
    >
      <label className={clsx('block text-sm font-medium mb-1', error ? 'text-red-600' : 'text-gray-700')}>
        {label} {error && <span className="text-red-500">*</span>}
      </label>
      {children}
    </div>
  );
}
