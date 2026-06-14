'use client';

import { useEffect, useState } from 'react';
import { ExtractedData, Invoice, AccountMapping } from '@/shared/types';
import { approveInvoice } from '@/lib/api';
import { createClient } from '@/utils/supabase/client';
import clsx from 'clsx';
import { AlertCircle, CheckCircle, CheckCircle2, AlertTriangle, XCircle, FileText, Calculator, Landmark } from 'lucide-react';
import { useToast } from '@/components/ui/Toast';

interface Props {
  invoice: Invoice;
  onApproved: () => void;
  onFieldFocus?: (field: string | null) => void;
}

type SupplierStatus = 'known' | 'unknown' | 'loading';

export function ValidationForm({ invoice, onApproved, onFieldFocus }: Props) {
  const supabase = createClient();
  const { toast } = useToast();
  
  const initial = invoice.validated_data ?? invoice.extracted_data;
  const [data, setData] = useState<Partial<ExtractedData>>(initial ?? {});
  const [saving, setSaving] = useState(false);
  const [activeFormTab, setActiveFormTab] = useState<'invoice' | 'bank'>('invoice');
  const [rejecting, setRejecting] = useState(false);
  const [error, setError] = useState('');
  const [categories, setCategories] = useState<string[]>([]);
  const [dbMappings, setDbMappings] = useState<AccountMapping[]>([]);
  const [supplierMappingKeys, setSupplierMappingKeys] = useState<string[] | null>(null);
  const [categoryMappingKeys, setCategoryMappingKeys] = useState<string[] | null>(null);
  const [supplierCode, setSupplierCode] = useState('');
  const [categoryCode, setCategoryCode] = useState('');
  const [isInitialized, setIsInitialized] = useState(false);

  const [webSearchVat, setWebSearchVat] = useState<string | null>(
    initial?.validation_flags?.vat_id_sources?.web_search ?? null
  );
  const [isSearchingWeb, setIsSearchingWeb] = useState(false);
  const [showVatDetails, setShowVatDetails] = useState(false);
  const [lastAutofilledVat, setLastAutofilledVat] = useState<string | null>(null);

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

  // Initialize form fields for known/Various Suppliers once mappings are loaded
  useEffect(() => {
    if (supplierMappingKeys === null || isInitialized) return;

    const originalName = invoice.extracted_data?.supplier_name;
    const mapping = dbMappings.find(
      (m) => m.mapping_type === 'supplier' && m.key === originalName
    );

    if (mapping) {
      if (mapping.account_code === '3499') {
        setData((prev) => ({
          ...prev,
          supplier_name: 'ספקים שונים',
        }));
        setSupplierCode('3499');
      } else {
        setData((prev) => ({
          ...prev,
          supplier_name: mapping.key,
        }));
        setSupplierCode(mapping.account_code);
      }
    } else {
      setData((prev) => ({
        ...prev,
        supplier_name: 'ספקים שונים',
      }));
      setSupplierCode('3499');
    }
    setIsInitialized(true);
  }, [dbMappings, supplierMappingKeys, invoice.extracted_data?.supplier_name, isInitialized]);

  useEffect(() => {
    if (!data.supplier_name) return;
    const mapping = dbMappings.find(
      (m) => m.mapping_type === 'supplier' && m.key === data.supplier_name
    );
    if (mapping) {
      setData((prev) => {
        const next = { ...prev };
        let updated = false;
        if (mapping.expense_category && !prev.expense_category) {
          next.expense_category = mapping.expense_category;
          updated = true;
        }
        if (mapping.vat_id && prev.supplier_vat_id !== mapping.vat_id) {
          next.supplier_vat_id = mapping.vat_id;
          updated = true;
        }
        return updated ? next : prev;
      });
    }
  }, [data.supplier_name, dbMappings]);

  // Dynamic Gov.il API search on supplier name change (with debounce)
  useEffect(() => {
    if (!data.supplier_name || data.supplier_name.trim().length < 2) {
      setWebSearchVat(null);
      return;
    }

    if (data.supplier_name === initial?.supplier_name) {
      setWebSearchVat(initial?.validation_flags?.vat_id_sources?.web_search ?? null);
      return;
    }

    setIsSearchingWeb(true);
    const delayDebounce = setTimeout(() => {
      fetch(`/api/suppliers/search-vat?name=${encodeURIComponent(data.supplier_name!)}`)
        .then((res) => {
          if (!res.ok) throw new Error('API request failed');
          return res.json();
        })
        .then((resData) => {
          setWebSearchVat(resData.vatId || null);
        })
        .catch((err) => {
          console.error('Failed to search VAT ID for name:', err);
          setWebSearchVat(null);
        })
        .finally(() => {
          setIsSearchingWeb(false);
        });
    }, 600);

    return () => clearTimeout(delayDebounce);
  }, [data.supplier_name, initial?.supplier_name, initial?.validation_flags?.vat_id_sources?.web_search]);

  // Autofill VAT ID if web search finds a result and the field is currently blank
  useEffect(() => {
    if (!webSearchVat) {
      setLastAutofilledVat(null);
      return;
    }
    if (webSearchVat && !data.supplier_vat_id && webSearchVat !== lastAutofilledVat) {
      setData((prev) => ({ ...prev, supplier_vat_id: webSearchVat }));
      setLastAutofilledVat(webSearchVat);
    }
  }, [webSearchVat, data.supplier_vat_id, lastAutofilledVat]);

  const originalSupplierName = invoice.extracted_data?.supplier_name || '';

  const originalSupplierMapping = dbMappings.find(
    (m) => m.mapping_type === 'supplier' && m.key === originalSupplierName
  );

  const isVariousSuppliers = supplierMappingKeys !== null && (
    !originalSupplierMapping || originalSupplierMapping.account_code === '3499'
  );

  const isKnownSupplier = supplierMappingKeys !== null &&
    !!originalSupplierMapping && originalSupplierMapping.account_code !== '3499';

  const supplierStatus: SupplierStatus = supplierMappingKeys === null
    ? 'loading'
    : isKnownSupplier ? 'known' : 'unknown';

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

  const getVatIdError = (vatId: string | null): string | null => {
    if (!vatId) return null;
    let digits = vatId.replace(/\D/g, '');
    if (digits.length === 8) {
      digits = '0' + digits;
    }
    if (digits.length !== 9) {
      return 'חייב להיות 9 ספרות';
    }

    // Israeli Luhn checksum algorithm
    let sum = 0;
    for (let i = 0; i < 9; i++) {
      let d = parseInt(digits[i]);
      if (i % 2 === 1) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      sum += d;
    }
    if (sum % 10 !== 0) {
      return 'מספר עוסק לא תקין (ספרת ביקורת שגויה)';
    }
    return null;
  };

  const checkVatId = (vatId: string | null): boolean => {
    return !getVatIdError(vatId);
  };

  const vatIdErrorText = getVatIdError(data.supplier_vat_id ?? null);
  const isVatIdOk = !vatIdErrorText;

  const isDateEmpty = !data.invoice_date;
  const isAmountBeforeVatEmpty = data.amount_before_vat == null || isNaN(data.amount_before_vat);
  const isVatAmountEmpty = data.vat_amount == null || isNaN(data.vat_amount);
  const isTotalAmountEmpty = data.total_amount == null || isNaN(data.total_amount);

  const hasInvoiceTabError =
    fieldError('supplier_name') ||
    fieldError('invoice_number') ||
    fieldError('invoice_date') ||
    fieldError('expense_category') ||
    fieldError('supplier_vat_id') ||
    !isVatIdOk ||
    (supplierStatus === 'unknown' && !supplierCode.trim()) ||
    mathError ||
    !mathOk ||
    fieldError('amount_before_vat') ||
    fieldError('vat_amount') ||
    fieldError('total_amount') ||
    isDateEmpty ||
    isAmountBeforeVatEmpty ||
    isVatAmountEmpty ||
    isTotalAmountEmpty;

  const hasBankData = !!(data.bank_name || data.bank_branch_name || data.bank_branch_code || data.bank_account);

  const handleApprove = async () => {
    if (isDateEmpty || isAmountBeforeVatEmpty || isVatAmountEmpty || isTotalAmountEmpty) {
      setError('יש למלא את כל שדות החובה: תאריך חשבונית, לפני מע״מ, מע"מ, וסה״כ לתשלום.');
      return;
    }
    setSaving(true); setError('');
    try {
      const originalName = invoice.extracted_data?.supplier_name;
      const mappingExists = dbMappings.some(
        (m) => m.mapping_type === 'supplier' && m.key === originalName
      );
      if (supplierStatus === 'unknown' && supplierCode.trim() && originalName && !mappingExists) {
        await supabase.from('account_mappings').insert({
          client_id: invoice.client_id,
          mapping_type: 'supplier',
          key: originalName,
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

      // Ensure the validated data has the correct, dynamic validation_flags before saving
      const updatedData = { ...data };
      if (updatedData.validation_flags) {
        const vatIdOk = checkVatId(updatedData.supplier_vat_id ?? null);
        const mathOk = !mathError;
        
        let ruleViolations = [...(updatedData.validation_flags.rule_violations || [])];
        if (vatIdOk) {
          ruleViolations = ruleViolations.filter(
            (v) => !v.includes('checksum') && !v.includes('תקין')
          );
        } else {
          if (!ruleViolations.some(v => v.includes('checksum'))) {
            ruleViolations.push('ח.פ. / עוסק מורשה אינו תקין לפי בדיקת checksum');
          }
        }

        updatedData.validation_flags = {
          ...updatedData.validation_flags,
          vat_id_ok: vatIdOk,
          math_ok: mathOk,
          rule_violations: ruleViolations,
        };
      }

      await approveInvoice(invoice.id, updatedData);
      toast('החשבונית אושרה בהצלחה', 'success');
      onApproved();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const handleReject = async () => {
    setRejecting(true); setError('');
    try {
      const { error: dbErr } = await supabase
        .from('invoices')
        .update({
          status: 'rejected',
          updated_at: new Date().toISOString(),
        })
        .eq('id', invoice.id);

      if (dbErr) throw dbErr;

      toast('החשבונית סומנה כלא מאושרת', 'info');
      onApproved();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setRejecting(false);
    }
  };

  const isApproved = invoice.status === 'approved';
  const isRejected = invoice.status === 'rejected';
  const isError = invoice.status === 'error';
  const isReadOnly = isApproved || isRejected || isError || invoice.status === 'exported';

  const isApproveDisabled =
    saving ||
    rejecting ||
    mathError ||
    supplierStatus === 'loading' ||
    (supplierStatus === 'unknown' && !supplierCode.trim()) ||
    isDateEmpty ||
    isAmountBeforeVatEmpty ||
    isVatAmountEmpty ||
    isTotalAmountEmpty;

  return (
    <div className="h-full flex flex-col" style={{ direction: 'rtl' }}>
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

      {/* Tab Switcher Buttons */}
      <div className="px-4 py-2 bg-slate-50/50 border-b border-slate-100 flex gap-2 shrink-0">
        <button
          type="button"
          onClick={() => setActiveFormTab('invoice')}
          className={clsx(
            'flex-1 flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl text-xs font-bold border transition-all duration-200 focus:outline-none',
            activeFormTab === 'invoice'
              ? 'bg-blue-600 border-blue-600 text-white shadow-sm'
              : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50 hover:text-slate-800'
          )}
        >
          <FileText className="h-3.5 w-3.5" />
          <span>חשבונית וסכומים</span>
          {hasInvoiceTabError && (
            <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
          )}
        </button>

        <button
          type="button"
          onClick={() => setActiveFormTab('bank')}
          className={clsx(
            'flex-1 flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl text-xs font-bold border transition-all duration-200 focus:outline-none',
            activeFormTab === 'bank'
              ? 'bg-blue-600 border-blue-600 text-white shadow-sm'
              : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50 hover:text-slate-800'
          )}
        >
          <Landmark className="h-3.5 w-3.5" />
          <span>פרטי בנק</span>
          {hasBankData && (
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" title="קיימים פרטי בנק להעברה" />
          )}
        </button>
      </div>

      {/* Fields */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {activeFormTab === 'invoice' && (
          <div className="space-y-4 animate-in fade-in duration-200">
            <Field label="שם ספק" error={fieldError('supplier_name')} fieldKey="supplier_name" onFieldFocus={onFieldFocus}
              badge={
                supplierStatus === 'known'
                  ? <span className="flex items-center gap-1 text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full font-medium animate-in fade-in duration-200">
                      <CheckCircle2 className="h-3 w-3" /> ספק מוכר {originalSupplierMapping && `(קוד: ${originalSupplierMapping.account_code})`}
                    </span>
                  : supplierStatus === 'unknown'
                  ? <span className={clsx(
                      "flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium border animate-in fade-in duration-200",
                      originalSupplierMapping
                        ? "text-indigo-700 bg-indigo-50 border-indigo-200"
                        : "text-amber-700 bg-amber-50 border-amber-200"
                    )}>
                      {originalSupplierMapping ? (
                        <>
                          <CheckCircle2 className="h-3 w-3" /> ספקים שונים
                        </>
                      ) : (
                        <>
                          <AlertTriangle className="h-3 w-3" /> ספק חדש
                        </>
                      )}
                    </span>
                  : null
              }
            >
              <input
                className={clsx('input-base disabled:opacity-75 disabled:bg-slate-50/80 disabled:cursor-not-allowed', fieldError('supplier_name') && 'input-error')}
                value={data.supplier_name ?? ''}
                onChange={(e) => set('supplier_name', e.target.value)}
                onFocus={() => onFieldFocus?.('supplier_name')}
                onBlur={() => onFieldFocus?.(null)}
                disabled={isReadOnly}
              />
            </Field>

            {/* Original Supplier Name Card */}
            {isVariousSuppliers && originalSupplierName && (
              <div className="flex flex-col gap-1.5 p-3 bg-blue-50/40 border border-blue-100/70 rounded-xl text-xs text-blue-800 animate-in fade-in duration-200">
                <div className="flex items-center gap-1.5 font-semibold">
                  <FileText className="h-3.5 w-3.5 text-blue-600 shrink-0" />
                  <span>שם הספק המקורי שזוהה בחשבונית:</span>
                </div>
                <div className="bg-white border border-blue-200/60 px-2.5 py-1.5 rounded-lg font-mono font-medium text-slate-800 break-all animate-in zoom-in-95 duration-200">
                  {originalSupplierName}
                </div>
                <p className="text-[10px] text-slate-500">
                  {originalSupplierMapping
                    ? "ספק זה מוגדר תחת חשבון 'ספקים שונים'. שם הספק הוחלף ל-'ספקים שונים' בקוד 3499."
                    : "ספק זה אינו מוגדר במערכת. שם הספק הוחלף ל-'ספקים שונים' ויוגדר עם קוד חשבון 3499."}
                </p>
              </div>
            )}

            {supplierStatus === 'unknown' && !isReadOnly && (
              <div className={clsx(
                "flex items-center gap-2 -mt-2 px-3 py-2 border rounded-lg animate-in fade-in duration-200",
                supplierCode.trim() 
                  ? "bg-emerald-50/30 border-emerald-100" 
                  : "bg-amber-50 border-amber-200"
              )}>
                {supplierCode.trim() ? (
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                ) : (
                  <AlertTriangle className="h-3.5 w-3.5 text-amber-500 shrink-0" />
                )}
                <label className={clsx(
                  "text-xs shrink-0 font-semibold",
                  supplierCode.trim() ? "text-emerald-800" : "text-amber-800"
                )}>
                  קוד חשבון ספק:
                </label>
                <input
                  className={clsx(
                    "input-base py-1 text-sm font-mono flex-1 disabled:opacity-75 disabled:bg-slate-50/80",
                    supplierCode.trim()
                      ? "border-emerald-200 focus:ring-emerald-500/20 focus:border-emerald-500 bg-white"
                      : "border-amber-300 focus:ring-amber-500/20 focus:border-amber-500 bg-amber-50/10"
                  )}
                  placeholder="חובה להזין קוד ספק לאישור (לדוג׳ 2340)"
                  value={supplierCode}
                  onChange={(e) => setSupplierCode(e.target.value)}
                  disabled={isReadOnly}
                />
              </div>
            )}

            <Field label="ח.פ. / עוסק מורשה" error={fieldError('supplier_vat_id') || !isVatIdOk} fieldKey="supplier_vat_id" onFieldFocus={onFieldFocus}>
              <input
                className={clsx('input-base disabled:opacity-75 disabled:bg-slate-50/80 disabled:cursor-not-allowed', (fieldError('supplier_vat_id') || !isVatIdOk) && 'input-error')}
                value={data.supplier_vat_id ?? ''}
                onChange={(e) => set('supplier_vat_id', e.target.value)}
                onFocus={() => onFieldFocus?.('supplier_vat_id')}
                onBlur={() => onFieldFocus?.(null)}
                disabled={isReadOnly}
              />
              {fieldError('supplier_vat_id') && !data.supplier_vat_id && (
                <p className="text-xs text-red-600 mt-1">ח.פ. הוא שדה חובה</p>
              )}
              {vatIdErrorText && (
                <p className="text-xs text-red-600 mt-1">{vatIdErrorText}</p>
              )}

              {/* Composed VAT ID Sources Feedback Indicator */}
              {(() => {
                const hasInvoiceVat = !!invoice.extracted_data?.supplier_vat_id;
                const matchingMapping = dbMappings.find(
                  (m) => m.mapping_type === 'supplier' && m.key === data.supplier_name
                );
                const tableVatId = matchingMapping?.vat_id || null;
                const hasTableVat = !!tableVatId;
                const hasWebSearchVat = !!webSearchVat;

                return (
                  <div className="mt-2">
                    <button
                      type="button"
                      onClick={() => setShowVatDetails(!showVatDetails)}
                      className="flex items-center gap-2 px-3 py-1 bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded-full text-xs text-slate-600 transition-colors shadow-sm focus:outline-none"
                    >
                      <span className="font-medium">מקורות זיהוי ח.פ:</span>
                      <div className="flex gap-1.5 items-center">
                        <span
                          className={clsx(
                            "w-2 h-2 rounded-full transition-colors",
                            hasInvoiceVat ? "bg-emerald-500" : "bg-rose-500"
                          )}
                          title="זיהוי מהחשבונית עצמה"
                        />
                        <span
                          className={clsx(
                            "w-2 h-2 rounded-full transition-colors",
                            hasTableVat ? "bg-emerald-500" : "bg-rose-500"
                          )}
                          title="זיהוי מטבלת הספקים"
                        />
                        <span
                          className={clsx(
                            "w-2 h-2 rounded-full transition-colors",
                            hasWebSearchVat ? "bg-emerald-500" : "bg-rose-500"
                          )}
                          title="חיפוש באינטרנט"
                        />
                      </div>
                    </button>

                    {showVatDetails && (
                      <div className="mt-2 p-3 bg-slate-50 border border-slate-200 rounded-xl space-y-2 text-xs text-slate-700 animate-in slide-in-from-top-2 duration-200">
                        <div className="flex items-center justify-between font-semibold text-slate-500 pb-1.5 border-b border-slate-200/60">
                          <span>מקור זיהוי</span>
                          <span>סטטוס / ערך</span>
                        </div>

                        <div className="flex items-center justify-between pt-1">
                          <span className="flex items-center gap-1.5">
                            <span className={clsx("w-2 h-2 rounded-full", hasInvoiceVat ? "bg-emerald-500" : "bg-rose-500")} />
                            זיהוי מהחשבונית עצמה:
                          </span>
                          <span className="font-mono font-medium">
                            {hasInvoiceVat ? invoice.extracted_data?.supplier_vat_id : "לא נמצא"}
                          </span>
                        </div>

                        <div className="flex items-center justify-between pt-1 border-t border-slate-200/40">
                          <span className="flex items-center gap-1.5">
                            <span className={clsx("w-2 h-2 rounded-full", hasTableVat ? "bg-emerald-500" : "bg-rose-500")} />
                            זיהוי מטבלת ספקים:
                          </span>
                          <span className="font-mono font-medium flex items-center gap-1">
                            {hasTableVat ? (
                              <>
                                {tableVatId}
                                <span className="text-[10px] text-emerald-600 bg-emerald-50 border border-emerald-200 px-1 py-0.2 rounded font-normal">מוגדר</span>
                              </>
                            ) : (
                              "לא מוגדר במערכת"
                            )}
                          </span>
                        </div>

                        <div className="flex items-center justify-between pt-1 border-t border-slate-200/40">
                          <span className="flex items-center gap-1.5">
                            <span className={clsx("w-2 h-2 rounded-full", hasWebSearchVat ? "bg-emerald-500" : "bg-rose-500")} />
                            חיפוש באינטרנט לפי שם:
                          </span>
                          <span className="font-mono font-medium">
                            {isSearchingWeb ? (
                              <span className="text-slate-400 animate-pulse">מחפש...</span>
                            ) : hasWebSearchVat ? (
                              webSearchVat
                            ) : (
                              "לא נמצא בחיפוש"
                            )}
                          </span>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="מספר חשבונית" error={fieldError('invoice_number')} fieldKey="invoice_number" onFieldFocus={onFieldFocus}>
                <input
                  className={clsx('input-base disabled:opacity-75 disabled:bg-slate-50/80 disabled:cursor-not-allowed', fieldError('invoice_number') && 'input-error')}
                  value={data.invoice_number ?? ''}
                  onChange={(e) => set('invoice_number', e.target.value)}
                  onFocus={() => onFieldFocus?.('invoice_number')}
                  onBlur={() => onFieldFocus?.(null)}
                  disabled={isReadOnly}
                />
              </Field>

              <Field label="תאריך חשבונית" error={fieldError('invoice_date') || isDateEmpty} fieldKey="invoice_date" onFieldFocus={onFieldFocus}>
                <input
                  type="date"
                  className={clsx('input-base disabled:opacity-75 disabled:bg-slate-50/80 disabled:cursor-not-allowed', (fieldError('invoice_date') || isDateEmpty) && 'input-error')}
                  value={data.invoice_date ?? ''}
                  onChange={(e) => set('invoice_date', e.target.value || null)}
                  onFocus={() => onFieldFocus?.('invoice_date')}
                  onBlur={() => onFieldFocus?.(null)}
                  disabled={isReadOnly}
                />
              </Field>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <Field label="לפני מע״מ" error={mathError || isAmountBeforeVatEmpty} fieldKey="amount_before_vat" onFieldFocus={onFieldFocus}>
                <input
                  type="number"
                  step="0.01"
                  className={clsx('input-base disabled:opacity-75 disabled:bg-slate-50/80 disabled:cursor-not-allowed', (mathError || isAmountBeforeVatEmpty) && 'input-error')}
                  value={data.amount_before_vat ?? ''}
                  onChange={(e) => set('amount_before_vat', e.target.value === '' ? null : parseFloat(e.target.value))}
                  onFocus={() => onFieldFocus?.('amount_before_vat')}
                  onBlur={() => onFieldFocus?.(null)}
                  disabled={isReadOnly}
                />
              </Field>
              <Field label='מע"מ' error={mathError || isVatAmountEmpty} fieldKey="vat_amount" onFieldFocus={onFieldFocus}>
                <input
                  type="number"
                  step="0.01"
                  className={clsx('input-base disabled:opacity-75 disabled:bg-slate-50/80 disabled:cursor-not-allowed', (mathError || isVatAmountEmpty) && 'input-error')}
                  value={data.vat_amount ?? ''}
                  onChange={(e) => set('vat_amount', e.target.value === '' ? null : parseFloat(e.target.value))}
                  onFocus={() => onFieldFocus?.('vat_amount')}
                  onBlur={() => onFieldFocus?.(null)}
                  disabled={isReadOnly}
                />
              </Field>
              <Field label="סה״כ לתשלום" error={mathError || isTotalAmountEmpty} fieldKey="total_amount" onFieldFocus={onFieldFocus}>
                <input
                  type="number"
                  step="0.01"
                  className={clsx('input-base disabled:opacity-75 disabled:bg-slate-50/80 disabled:cursor-not-allowed', (mathError || isTotalAmountEmpty) && 'input-error')}
                  value={data.total_amount ?? ''}
                  onChange={(e) => set('total_amount', e.target.value === '' ? null : parseFloat(e.target.value))}
                  onFocus={() => onFieldFocus?.('total_amount')}
                  onBlur={() => onFieldFocus?.(null)}
                  disabled={isReadOnly}
                />
              </Field>
            </div>
            {mathError && <p className="text-xs text-red-600">שגיאה: לפני מע"מ + מע"מ ≠ סה"כ</p>}

            <Field label="קטגוריית הוצאה" error={fieldError('expense_category')} fieldKey="expense_category" onFieldFocus={onFieldFocus}>
              <select
                className={clsx('input-base disabled:opacity-75 disabled:bg-slate-50/80 disabled:cursor-not-allowed', fieldError('expense_category') && 'input-error')}
                value={data.expense_category ?? ''}
                onChange={(e) => { set('expense_category', e.target.value); setCategoryCode(''); }}
                onFocus={() => onFieldFocus?.('expense_category')}
                onBlur={() => onFieldFocus?.(null)}
                disabled={isReadOnly}
              >
                <option value="">בחר קטגוריה...</option>
                {categories.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </Field>
            {categoryStatus === 'unknown' && data.expense_category && !isReadOnly && (
              <div className="flex items-center gap-2 -mt-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg animate-in fade-in duration-200">
                <AlertTriangle className="h-3.5 w-3.5 text-amber-500 shrink-0" />
                <label className="text-xs text-amber-800 shrink-0">קוד חשבון קטגוריה:</label>
                <input
                  className="input-base py-1 text-sm font-mono flex-1 disabled:opacity-75 disabled:bg-slate-50/80"
                  placeholder="לדוג׳ 4001 — ריק = ייצוא ייחסם"
                  value={categoryCode}
                  onChange={(e) => setCategoryCode(e.target.value)}
                  disabled={isReadOnly}
                />
              </div>
            )}
          </div>
        )}

        {activeFormTab === 'bank' && (
          <div className="space-y-4 animate-in fade-in duration-200">
            <h3 className="text-sm font-semibold text-slate-700 pb-1 border-b border-slate-100">פרטי חשבון בנק להעברה</h3>
            
            <div className="grid grid-cols-2 gap-3">
              <Field label="שם הבנק" error={false} fieldKey="bank_name" onFieldFocus={onFieldFocus}>
                <input
                  className="input-base disabled:opacity-75 disabled:bg-slate-50/80 disabled:cursor-not-allowed"
                  placeholder="למשל: הבינלאומי"
                  value={data.bank_name ?? ''}
                  onChange={(e) => set('bank_name', e.target.value)}
                  onFocus={() => onFieldFocus?.('bank_name')}
                  onBlur={() => onFieldFocus?.(null)}
                  disabled={isReadOnly}
                />
              </Field>
              <Field label="שם הסניף" error={false} fieldKey="bank_branch_name" onFieldFocus={onFieldFocus}>
                <input
                  className="input-base disabled:opacity-75 disabled:bg-slate-50/80 disabled:cursor-not-allowed"
                  placeholder="למשל: אשקלון"
                  value={data.bank_branch_name ?? ''}
                  onChange={(e) => set('bank_branch_name', e.target.value)}
                  onFocus={() => onFieldFocus?.('bank_branch_name')}
                  onBlur={() => onFieldFocus?.(null)}
                  disabled={isReadOnly}
                />
              </Field>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Field label="מספר סניף" error={false} fieldKey="bank_branch_code" onFieldFocus={onFieldFocus}>
                <input
                  className="input-base font-mono disabled:opacity-75 disabled:bg-slate-50/80 disabled:cursor-not-allowed"
                  placeholder="למשל: 109"
                  value={data.bank_branch_code ?? ''}
                  onChange={(e) => set('bank_branch_code', e.target.value)}
                  onFocus={() => onFieldFocus?.('bank_branch_code')}
                  onBlur={() => onFieldFocus?.(null)}
                  disabled={isReadOnly}
                />
              </Field>
              <Field label="מספר חשבון" error={false} fieldKey="bank_account" onFieldFocus={onFieldFocus}>
                <input
                  className="input-base font-mono disabled:opacity-75 disabled:bg-slate-50/80 disabled:cursor-not-allowed"
                  placeholder="למשל: 566204"
                  value={data.bank_account ?? ''}
                  onChange={(e) => set('bank_account', e.target.value)}
                  onFocus={() => onFieldFocus?.('bank_account')}
                  onBlur={() => onFieldFocus?.(null)}
                  disabled={isReadOnly}
                />
              </Field>
            </div>
          </div>
        )}
      </div>


      {/* Footer */}
      <div className="px-4 py-4 border-t border-slate-100 bg-white">
        {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
        
        {isReadOnly ? (
          <div className="w-full flex items-center justify-center p-3.5 rounded-xl border text-sm font-semibold">
            {isApproved && (
              <span className="text-emerald-700 bg-emerald-50 border-emerald-200 flex items-center gap-2 px-3 py-1 rounded-full border">
                <CheckCircle className="h-4 w-4" /> חשבונית זו אושרה
              </span>
            )}
            {isRejected && (
              <span className="text-rose-700 bg-rose-50 border-rose-200 flex items-center gap-2 px-3 py-1 rounded-full border">
                <XCircle className="h-4 w-4" /> חשבונית זו לא אושרה
              </span>
            )}
            {isError && (
              <span className="text-red-700 bg-red-50 border-red-200 flex items-center gap-2 px-3 py-1 rounded-full border">
                <XCircle className="h-4 w-4 shrink-0" /> {invoice.error_message || 'המסמך לא זוהה כחשבונית'}
              </span>
            )}
            {invoice.status === 'exported' && (
              <span className="text-slate-600 bg-slate-50 border-slate-200 flex items-center gap-2 px-3 py-1 rounded-full border">
                <CheckCircle className="h-4 w-4" /> חשבונית זו כבר יוצאה
              </span>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <button
              onClick={handleReject}
              disabled={saving || rejecting}
              className="flex-1 py-3 bg-white border border-rose-200 hover:bg-rose-50 text-rose-700 font-semibold text-sm rounded-xl transition-colors disabled:opacity-60 flex items-center justify-center gap-2 shadow-sm"
            >
              {rejecting ? 'פוסל...' : 'לא מאושר'}
            </button>
            <button
              onClick={handleApprove}
              disabled={isApproveDisabled}
              className="flex-1 py-3 bg-blue-600 hover:bg-blue-700 text-white font-semibold text-sm rounded-xl shadow-sm transition-colors disabled:opacity-60 flex items-center justify-center gap-2"
            >
              {saving ? 'מאשר...' : 'אשר חשבונית'}
            </button>
          </div>
        )}
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
        <label className={clsx('text-sm font-semibold', error ? 'text-red-600' : 'text-slate-700')}>
          {label}{error && <span className="text-red-500 mr-0.5">*</span>}
        </label>
        {badge}
      </div>
      {children}
    </div>
  );
}
