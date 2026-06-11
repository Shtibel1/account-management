'use client';

import { useEffect, useState } from 'react';
import { ExtractedData, Invoice, AccountMapping } from '@invoice/shared-types';
import { approveInvoice } from '@/lib/api';
import { createClient } from '@/utils/supabase/client';
import clsx from 'clsx';
import { AlertCircle, CheckCircle, CheckCircle2, AlertTriangle } from 'lucide-react';

interface Props {
  invoice: Invoice;
  onApproved: () => void;
  onFieldFocus?: (field: string | null) => void;
}

type SupplierStatus = 'known' | 'unknown' | 'loading';

export function ValidationForm({ invoice, onApproved, onFieldFocus }: Props) {
  const supabase = createClient();
  const initial = invoice.validated_data ?? invoice.extracted_data;
  const [data, setData] = useState<Partial<ExtractedData>>(initial ?? {});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [categories, setCategories] = useState<string[]>([]);
  const [dbMappings, setDbMappings] = useState<AccountMapping[]>([]);
  const [supplierMappingKeys, setSupplierMappingKeys] = useState<string[] | null>(null);
  const [categoryMappingKeys, setCategoryMappingKeys] = useState<string[] | null>(null);
  const [supplierCode, setSupplierCode] = useState('');
  const [categoryCode, setCategoryCode] = useState('');

  useEffect(() => {
    if (!invoice.client_id) return;

    supabase
      .from('account_mappings')
      .select('*')
      .eq('client_id', invoice.client_id)
      .then(({ data: mappings }) => {
        if (!mappings) return;
        setDbMappings(mappings as AccountMapping[]);

        const dbCategories = mappings
          .filter((m) => m.mapping_type === 'category')
          .map((m) => m.key);
        const knownSuppliers = mappings
          .filter((m) => m.mapping_type === 'supplier')
          .map((m) => m.key);

        if (dbCategories.length > 0) setCategories(dbCategories);
        setSupplierMappingKeys(knownSuppliers);
        setCategoryMappingKeys(dbCategories);
      });
  }, [invoice.client_id]);

  useEffect(() => {
    if (!data.supplier_name || data.expense_category) return;
    const mapping = dbMappings.find(
      (m) => m.mapping_type === 'supplier' && m.key === data.supplier_name
    );
    if (mapping?.expense_category) {
      setData((prev) => ({ ...prev, expense_category: mapping.expense_category }));
    }
  }, [data.supplier_name, dbMappings]);

  const supplierStatus: SupplierStatus = supplierMappingKeys === null
    ? 'loading'
    : (initial?.supplier_name && supplierMappingKeys.includes(initial.supplier_name) ? 'known' : 'unknown');

  const categoryStatus: 'known' | 'unknown' | 'loading' = categoryMappingKeys === null
    ? 'loading'
    : (data.expense_category && categoryMappingKeys.includes(data.expense_category) ? 'known' : 'unknown');

  const flags = initial?.validation_flags;
  const mathOk = flags?.math_ok ?? true;
  const warnings = flags?.warnings ?? [];

  const set = (key: keyof ExtractedData, value: any) =>
    setData((prev) => ({ ...prev, [key]: value }));

  const fieldError = (key: string) => flags?.fields_missing?.includes(key) ?? false;

  const mathError =
    data.amount_before_vat != null && data.vat_amount != null && data.total_amount != null &&
    Math.abs((data.amount_before_vat + data.vat_amount) - data.total_amount) > 1;

  const handleApprove = async () => {
    setSaving(true); setError('');
    try {
      if (supplierStatus === 'unknown' && supplierCode.trim() && initial?.supplier_name) {
        await supabase.from('account_mappings').insert({
          client_id: invoice.client_id,
          mapping_type: 'supplier',
          key: initial.supplier_name,
          account_code: supplierCode.trim(),
        });
      }
      if (categoryStatus === 'unknown' && categoryCode.trim() && data.expense_category) {
        await supabase.from('account_mappings').insert({
          client_id: invoice.client_id,
          mapping_type: 'category',
          key: data.expense_category,
          account_code: categoryCode.trim(),
        });
      }
      await approveInvoice(invoice.id, data);
      onApproved();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const isApproved = invoice.status === 'approved';

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="px-5 py-4 border-b border-slate-100 bg-white">
        <h2 className="font-semibold text-slate-900 truncate">{invoice.file_name}</h2>
        {invoice.ai_confidence != null && (
          <div className="flex items-center gap-2 mt-1.5">
            <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
              <div
                className="h-full bg-blue-500 rounded-full"
                style={{ width: `${Math.round(invoice.ai_confidence * 100)}%` }}
              />
            </div>
            <span className="text-xs text-slate-500">ביטחון AI: {Math.round(invoice.ai_confidence * 100)}%</span>
          </div>
        )}
      </div>

      {/* Alerts */}
      {!mathOk && (
        <div className="mx-4 mt-3 flex items-center gap-2.5 p-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
          <AlertCircle className="h-4 w-4 shrink-0" />
          סכומים לא מסתדרים — בדוק את הנתונים מול המסמך
        </div>
      )}
      {warnings.map((w, i) => (
        <div key={i} className="mx-4 mt-2 flex items-start gap-2.5 p-3 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-800">
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          {w}
        </div>
      ))}

      {/* Fields */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">

        <Field label="שם ספק" error={fieldError('supplier_name')} fieldKey="supplier_name" onFieldFocus={onFieldFocus}
          badge={
            supplierStatus === 'known'
              ? <span className="flex items-center gap-1 text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full">
                  <CheckCircle2 className="h-3 w-3" /> ספק מוכר
                </span>
              : supplierStatus === 'unknown'
              ? <span className="flex items-center gap-1 text-xs text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full">
                  <AlertTriangle className="h-3 w-3" /> ספק חדש
                </span>
              : null
          }
        >
          <input
            className={clsx('input-base', fieldError('supplier_name') && 'input-error')}
            value={data.supplier_name ?? ''}
            onChange={(e) => set('supplier_name', e.target.value)}
            onFocus={() => onFieldFocus?.('supplier_name')}
            onBlur={() => onFieldFocus?.(null)}
          />
        </Field>
        {supplierStatus === 'unknown' && (
          <div className="flex items-center gap-2 -mt-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg">
            <AlertTriangle className="h-3.5 w-3.5 text-amber-500 shrink-0" />
            <label className="text-xs text-amber-800 shrink-0">קוד חשבון ספק:</label>
            <input
              className="input-base py-1 text-sm font-mono flex-1"
              placeholder="לדוג׳ 2340 — ריק = ייצוא ייחסם"
              value={supplierCode}
              onChange={(e) => setSupplierCode(e.target.value)}
            />
          </div>
        )}

        <Field label="ח.פ. / עוסק מורשה" error={fieldError('supplier_vat_id') || !(flags?.vat_id_ok ?? true)} fieldKey="supplier_vat_id" onFieldFocus={onFieldFocus}>
          <input
            className={clsx('input-base', (fieldError('supplier_vat_id') || !(flags?.vat_id_ok ?? true)) && 'input-error')}
            value={data.supplier_vat_id ?? ''}
            onChange={(e) => set('supplier_vat_id', e.target.value)}
            onFocus={() => onFieldFocus?.('supplier_vat_id')}
            onBlur={() => onFieldFocus?.(null)}
          />
          {!(flags?.vat_id_ok ?? true) && (
            <p className="text-xs text-red-600 mt-1">מספר עוסק לא תקין (חייב להיות 9 ספרות)</p>
          )}
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="מספר חשבונית" error={fieldError('invoice_number')} fieldKey="invoice_number" onFieldFocus={onFieldFocus}>
            <input
              className={clsx('input-base', fieldError('invoice_number') && 'input-error')}
              value={data.invoice_number ?? ''}
              onChange={(e) => set('invoice_number', e.target.value)}
              onFocus={() => onFieldFocus?.('invoice_number')}
              onBlur={() => onFieldFocus?.(null)}
            />
          </Field>

          <Field label="תאריך חשבונית" error={fieldError('invoice_date')} fieldKey="invoice_date" onFieldFocus={onFieldFocus}>
            <input
              type="date"
              className={clsx('input-base', fieldError('invoice_date') && 'input-error')}
              value={data.invoice_date ?? ''}
              onChange={(e) => set('invoice_date', e.target.value)}
              onFocus={() => onFieldFocus?.('invoice_date')}
              onBlur={() => onFieldFocus?.(null)}
            />
          </Field>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <Field label="לפני מע״מ" error={mathError} fieldKey="amount_before_vat" onFieldFocus={onFieldFocus}>
            <input type="number" step="0.01" className={clsx('input-base', mathError && 'input-error')} value={data.amount_before_vat ?? ''} onChange={(e) => set('amount_before_vat', parseFloat(e.target.value))} onFocus={() => onFieldFocus?.('amount_before_vat')} onBlur={() => onFieldFocus?.(null)} />
          </Field>
          <Field label='מע"מ' error={mathError} fieldKey="vat_amount" onFieldFocus={onFieldFocus}>
            <input type="number" step="0.01" className={clsx('input-base', mathError && 'input-error')} value={data.vat_amount ?? ''} onChange={(e) => set('vat_amount', parseFloat(e.target.value))} onFocus={() => onFieldFocus?.('vat_amount')} onBlur={() => onFieldFocus?.(null)} />
          </Field>
          <Field label="סה״כ לתשלום" error={mathError} fieldKey="total_amount" onFieldFocus={onFieldFocus}>
            <input type="number" step="0.01" className={clsx('input-base', mathError && 'input-error')} value={data.total_amount ?? ''} onChange={(e) => set('total_amount', parseFloat(e.target.value))} onFocus={() => onFieldFocus?.('total_amount')} onBlur={() => onFieldFocus?.(null)} />
          </Field>
        </div>
        {mathError && <p className="text-xs text-red-600 -mt-2">שגיאה: לפני מע"מ + מע"מ ≠ סה"כ</p>}

        <Field label="קטגוריית הוצאה" error={fieldError('expense_category')} fieldKey="expense_category" onFieldFocus={onFieldFocus}>
          <select
            className={clsx('input-base', fieldError('expense_category') && 'input-error')}
            value={data.expense_category ?? ''}
            onChange={(e) => { set('expense_category', e.target.value); setCategoryCode(''); }}
            onFocus={() => onFieldFocus?.('expense_category')}
            onBlur={() => onFieldFocus?.(null)}
          >
            <option value="">בחר קטגוריה...</option>
            {categories.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </Field>
        {categoryStatus === 'unknown' && data.expense_category && (
          <div className="flex items-center gap-2 -mt-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg">
            <AlertTriangle className="h-3.5 w-3.5 text-amber-500 shrink-0" />
            <label className="text-xs text-amber-800 shrink-0">קוד חשבון קטגוריה:</label>
            <input
              className="input-base py-1 text-sm font-mono flex-1"
              placeholder="לדוג׳ 4001 — ריק = ייצוא ייחסם"
              value={categoryCode}
              onChange={(e) => setCategoryCode(e.target.value)}
            />
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-4 border-t border-slate-100 bg-white">
        {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
        <button
          onClick={handleApprove}
          disabled={saving || mathError || isApproved}
          className={clsx(
            'w-full py-3 rounded-xl font-semibold text-sm transition-colors flex items-center justify-center gap-2',
            isApproved
              ? 'bg-emerald-50 text-emerald-700 border border-emerald-200 cursor-default'
              : 'bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white shadow-sm'
          )}
        >
          {isApproved
            ? <><CheckCircle className="h-4 w-4" />אושר</>
            : saving ? 'שומר...' : 'אשר חשבונית'}
        </button>
      </div>
    </div>
  );
}

function Field({ label, error, fieldKey, onFieldFocus, badge, children }: {
  label: string;
  error: boolean;
  fieldKey?: string;
  onFieldFocus?: (field: string | null) => void;
  badge?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div
      onMouseEnter={() => fieldKey && onFieldFocus?.(fieldKey)}
      onMouseLeave={() => onFieldFocus?.(null)}
    >
      <div className="flex items-center justify-between mb-1.5">
        <label className={clsx('text-sm font-medium', error ? 'text-red-600' : 'text-slate-700')}>
          {label}{error && <span className="text-red-500 mr-0.5">*</span>}
        </label>
        {badge}
      </div>
      {children}
    </div>
  );
}
