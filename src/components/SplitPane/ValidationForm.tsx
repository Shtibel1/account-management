'use client';

import { Children, cloneElement, isValidElement, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ExtractedData, Invoice, AccountMapping, ConfidenceField, LineItem } from '@/shared/types';
import { MOVEIN_INVOICE_NUMBER_WIDTH } from '@/shared/exportData';
import { approveInvoice, deleteInvoice, reapplySupplierRules, rejectInvoice, reopenInvoice, retryInvoice } from '@/lib/api';
import { allocationThreshold, isAllocationRequired } from '@/shared/allocation';
import { isAllocationNumberAcceptable } from '@/shared/approvalValidation';
import { APPROVABLE_STATUSES, REJECTABLE_STATUSES, REOPENABLE_STATUSES } from '@/shared/invoiceStatus';
import { findSupplierRule, normalizeVatId, VARIOUS_SUPPLIERS_ACCOUNT } from '@/shared/supplierRules';
import { countHe, ruleReappliedMessage } from '@/shared/hebrewCount';
import { accountCodeError, mappingDbErrorMessage } from '@/shared/mappingValidation';
import { dismissDuplicateInFlags } from '@/shared/duplicates';
import { CONFIDENCE_FIELDS, fieldConfidence, isLowConfidence, pruneFieldConfidence } from '@/shared/confidence';
import { checkLineItemsSum, hasMixedVat, isLineItemWarning, normalizeLineItems } from '@/shared/lineItems';
import { lineItemsSumMismatch, liveReviewWarnings } from '@/shared/reviewWarnings';
import { createClient } from '@/utils/supabase/client';
import { isSpecificSupplierName } from '@/shared/supplierNameMatch';
import { LineItemsTable } from '@/components/SplitPane/LineItemsTable';
import clsx from 'clsx';
import { AlertCircle, CheckCircle, CheckCircle2, AlertTriangle, XCircle, FileText, Calculator, Landmark, Zap, Undo2, RotateCcw, Trash2 } from 'lucide-react';
import { useToast } from '@/components/ui/Toast';
import { useConfirm } from '@/components/ui/ConfirmDialog';
import { DuplicateAlert } from './DuplicateAlert';
import { RejectDialog } from '@/components/SplitPane/RejectDialog';
import { toUserErrorMessage } from '@/shared/processing';
import { BUYER_VAT_UNRESOLVED_VIOLATION } from '@/shared/buyerVatId';

interface Props {
  invoice: Invoice;
  onApproved: () => void;
  onFieldFocus?: (field: string | null) => void;
  /** Accountant review loop: shows "החזר ללקוח" (only passed while the feature flag is on). */
  onReturnToClient?: () => void;
}

type SupplierStatus = 'known' | 'unknown' | 'loading';

export function ValidationForm({ invoice, onApproved, onFieldFocus, onReturnToClient }: Props) {
  const supabase = createClient();
  const router = useRouter();
  const { toast } = useToast();
  const askConfirm = useConfirm();
  
  const initial = invoice.validated_data ?? invoice.extracted_data;
  const [data, setData] = useState<Partial<ExtractedData>>(initial ?? {});
  const [saving, setSaving] = useState(false);
  const [activeFormTab, setActiveFormTab] = useState<'invoice' | 'bank'>('invoice');
  const [rejecting, setRejecting] = useState(false);
  const [showRejectDialog, setShowRejectDialog] = useState(false);
  const [errorAction, setErrorAction] = useState<'retry' | 'delete' | 'reopen' | null>(null);
  const [error, setError] = useState('');
  const [categories, setCategories] = useState<string[]>([]);
  const [dbMappings, setDbMappings] = useState<AccountMapping[]>([]);
  const [supplierMappingKeys, setSupplierMappingKeys] = useState<string[] | null>(null);
  const [categoryMappingKeys, setCategoryMappingKeys] = useState<string[] | null>(null);
  const [supplierCode, setSupplierCode] = useState('');
  const [categoryCode, setCategoryCode] = useState('');
  const [saveCategoryAsDefault, setSaveCategoryAsDefault] = useState(false);
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

    // Supplier rule: matched by VAT ID first, then by the name the AI read
    const mapping = findSupplierRule(dbMappings, {
      supplier_name: invoice.extracted_data?.supplier_name,
      supplier_vat_id: initial?.supplier_vat_id,
    });

    if (mapping) {
      if (mapping.account_code === VARIOUS_SUPPLIERS_ACCOUNT) {
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
  }, [dbMappings, supplierMappingKeys, invoice.extracted_data?.supplier_name, initial?.supplier_vat_id, isInitialized]);

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
    // The catch-all placeholder (ספקים שונים) and generic one-word names ("חברה", "דלק") are not one
    // business: a registrar hit would be an unrelated company
    if (!isSpecificSupplierName(data.supplier_name)) {
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

  // Autofill VAT ID if web search finds a result and the field is currently blank. An existing VAT ID
  // is never replaced automatically: the sources panel offers the registrar's number with a confirm.
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

  const originalSupplierMapping = findSupplierRule(dbMappings, {
    supplier_name: originalSupplierName,
    supplier_vat_id: initial?.supplier_vat_id,
  }) ?? undefined;

  const isVariousSuppliers = supplierMappingKeys !== null && (
    !originalSupplierMapping || originalSupplierMapping.account_code === VARIOUS_SUPPLIERS_ACCOUNT
  );

  const isKnownSupplier = supplierMappingKeys !== null &&
    !!originalSupplierMapping && originalSupplierMapping.account_code !== VARIOUS_SUPPLIERS_ACCOUNT;

  const supplierStatus: SupplierStatus = supplierMappingKeys === null
    ? 'loading'
    : isKnownSupplier ? 'known' : 'unknown';

  const categoryStatus: 'known' | 'unknown' | 'loading' = categoryMappingKeys === null
    ? 'loading'
    : (data.expense_category && categoryMappingKeys.includes(data.expense_category) ? 'known' : 'unknown');

  const flags = initial?.validation_flags;
  const mathOk = flags?.math_ok ?? true;
  // Follows the current data while editing (a date entered, line items changed), not the stored run
  const uploadedAt = flags?.date_sanity?.reference_date ?? invoice.created_at ?? null;
  const warnings = liveReviewWarnings(flags?.warnings, { ...data, uploaded_at: uploadedAt });

  // Supplier rule (account_mappings) defaults: show which value came from the rule, and offer to
  // make the reviewer's category the supplier's default.
  const ruleCategory = initial?.supplier_rule?.applied?.expense_category ?? null;
  const isCategoryFromRule = !!ruleCategory && data.expense_category === ruleCategory;
  const canSaveCategoryAsDefault =
    isKnownSupplier && !!data.expense_category &&
    data.expense_category !== (originalSupplierMapping?.expense_category ?? null);

  const set = (key: keyof ExtractedData, value: any) =>
    setData((prev) => ({ ...prev, [key]: value }));

  const fieldError = (key: string) => flags?.fields_missing?.includes(key) ?? false;

  // Model confidence per field; hidden once the value no longer matches what the AI extracted
  const aiData = invoice.extracted_data;
  const liveConfidence = { field_confidence: pruneFieldConfidence(aiData?.field_confidence, aiData, data) };
  const confidenceFor = (field: ConfidenceField): number | null => fieldConfidence(liveConfidence, field);
  const lowConfidenceCount = CONFIDENCE_FIELDS.filter((f) => isLowConfidence(confidenceFor(f))).length;

  const initialLineItems = initial?.line_items ?? [];

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

  const allocationRequired = isAllocationRequired(data);
  const isAllocationMissing = allocationRequired && !data.allocation_number?.trim();
  const isAllocationMalformed = !!data.allocation_number?.trim() && !isAllocationNumberAcceptable(data.allocation_number);

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

  // Account codes go into the export: digits only
  const supplierCodeError = supplierStatus === 'unknown' && supplierCode.trim() ? accountCodeError(supplierCode) : null;
  const categoryCodeError =
    categoryStatus === 'unknown' && data.expense_category && categoryCode.trim() ? accountCodeError(categoryCode) : null;

  const hasBankData = !!(data.bank_name || data.bank_branch_name || data.bank_branch_code || data.bank_account);

  const handleApprove = async () => {
    if (isDateEmpty || isAmountBeforeVatEmpty || isVatAmountEmpty || isTotalAmountEmpty) {
      setError('יש למלא את כל שדות החובה: תאריך חשבונית, לפני מע״מ, מע"מ, וסה״כ לתשלום.');
      return;
    }
    // Same blocking rules as the server (src/shared/approvalValidation.ts)
    if (!isVatIdOk) {
      setError(`מספר עוסק / ח.פ. אינו תקין: ${vatIdErrorText}`);
      return;
    }
    if (isAllocationMissing) {
      setError('חסר מספר הקצאה - חובה בחשבונית זו (מעל סכום הסף לפני מע"מ)');
      return;
    }
    if (isAllocationMalformed) {
      setError('מספר ההקצאה אינו תקין - נדרשות 9 ספרות');
      return;
    }
    if (supplierCodeError || categoryCodeError) {
      setError(supplierCodeError ?? categoryCodeError ?? '');
      return;
    }
    // Line items that don't add up don't block approval, but the reviewer confirms it first
    if (lineItemsSumMismatch(data)) {
      setError('');
      const ok = await askConfirm({
        title: 'שורות הפריטים אינן תואמות לסכומים',
        message: (
          <span className="block space-y-1">
            {warnings.filter(isLineItemWarning).map((w, i) => <span key={i} className="block text-amber-800">{w}</span>)}
            <span className="block">לאשר את החשבונית בכל זאת?</span>
          </span>
        ),
        confirmLabel: 'אשר בכל זאת',
        cancelLabel: 'חזרה לעריכה',
      });
      if (!ok) return;
    }
    setSaving(true); setError('');
    try {
      const originalName = invoice.extracted_data?.supplier_name;
      const supplierVatId = normalizeVatId(data.supplier_vat_id);
      // Supplier rules created / changed here are re-applied to the client's other invoices in review
      const changedRules: { name: string | null; vatId: string | null }[] = [];
      if (supplierStatus === 'unknown' && supplierCode.trim() && originalName && !originalSupplierMapping) {
        const accountCode = supplierCode.trim();
        const { error: insertErr } = await supabase.from('account_mappings').insert({
          client_id: invoice.client_id,
          mapping_type: 'supplier',
          key: originalName,
          account_code: accountCode,
          vat_id: supplierVatId,
          // A catch-all supplier gets no default category from a single invoice
          expense_category: accountCode !== VARIOUS_SUPPLIERS_ACCOUNT ? data.expense_category || null : null,
        });
        if (insertErr) {
          console.error('[ValidationForm] Failed to save supplier mapping:', insertErr);
          throw new Error(mappingDbErrorMessage(insertErr) ?? 'שמירת קוד הספק נכשלה');
        }
        changedRules.push({ name: originalName, vatId: supplierVatId });
      }
      if (saveCategoryAsDefault && canSaveCategoryAsDefault && originalSupplierMapping) {
        const { error: updateErr } = await supabase
          .from('account_mappings')
          .update({ expense_category: data.expense_category })
          .eq('id', originalSupplierMapping.id);
        if (updateErr) {
          console.error('[ValidationForm] Failed to update supplier default category:', updateErr);
          throw new Error(mappingDbErrorMessage(updateErr) ?? 'עדכון קטגוריית ברירת המחדל של הספק נכשל');
        }
        changedRules.push({
          name: originalSupplierMapping.key,
          vatId: normalizeVatId(originalSupplierMapping.vat_id) ?? supplierVatId,
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
      // Keep model confidences only for fields the reviewer left as the AI extracted them
      updatedData.field_confidence = pruneFieldConfidence(data.field_confidence, invoice.extracted_data, updatedData);
      if (!updatedData.field_confidence) delete updatedData.field_confidence;
      if (updatedData.validation_flags) {
        const vatIdOk = checkVatId(updatedData.supplier_vat_id ?? null);
        const mathOk = !mathError;
        
        let ruleViolations = [...(updatedData.validation_flags.rule_violations || [])];
        if (vatIdOk) {
          ruleViolations = ruleViolations.filter(
            (v) => !v.includes('checksum') && !v.includes('תקין')
          );
          if (updatedData.supplier_vat_id) ruleViolations = ruleViolations.filter((v) => v !== BUYER_VAT_UNRESOLVED_VIOLATION);
        } else {
          if (!ruleViolations.some(v => v.includes('checksum'))) {
            ruleViolations.push('ח.פ. / עוסק מורשה אינו תקין לפי בדיקת checksum');
          }
        }

        ruleViolations = ruleViolations.filter((v) => !v.includes('מספר הקצאה'));
        if (isAllocationMissing) {
          ruleViolations.push(
            `חסר מספר הקצאה: חשבונית מעל ₪${allocationThreshold(updatedData.invoice_date)} לפני מע"מ — בלי מספר הקצאה לא ניתן לקזז את המע"מ`
          );
        }

        // Re-evaluate line items after reviewer edits (blank rows are dropped)
        const lineItems = normalizeLineItems(updatedData.line_items);
        updatedData.line_items = lineItems.length > 0 ? lineItems : null;
        const amounts = {
          line_items: lineItems,
          amount_before_vat: updatedData.amount_before_vat ?? null,
          vat_amount: updatedData.vat_amount ?? null,
          total_amount: updatedData.total_amount ?? null,
        };

        updatedData.validation_flags = {
          ...updatedData.validation_flags,
          vat_id_ok: vatIdOk,
          math_ok: mathOk,
          rule_violations: ruleViolations,
          allocation_required: allocationRequired,
          warnings: liveReviewWarnings(updatedData.validation_flags.warnings, { ...amounts, invoice_date: updatedData.invoice_date ?? null, uploaded_at: uploadedAt }),
          line_items_sum_ok: checkLineItemsSum(amounts).ok,
          mixed_vat: hasMixedVat(lineItems),
        };
      }

      const approval = await approveInvoice(invoice.id, updatedData);
      toast('החשבונית אושרה בהצלחה', 'success');
      if (approval?.autoApproveDisabled) {
        toast('האישור האוטומטי לספק זה כובה בעקבות התיקונים', 'info');
      }
      // Corrected values printed in the document: where this supplier prints them was learned
      const learnedRules = Array.isArray(approval?.learning?.rules) && approval.learning.in_document?.length > 0
        ? (approval.learning.rules as { active?: boolean; removed?: boolean }[]).filter((r) => r.active && !r.removed).length
        : 0;
      if (learnedRules > 0) {
        toast(learnedRules === 1 ? 'המערכת למדה מהתיקון ותשתמש בו בחשבוניות הבאות של הספק' : `המערכת למדה ${learnedRules} כללים מהתיקונים ותשתמש בהם בחשבוניות הבאות של הספק`, 'info');
      }
      if (Array.isArray(approval?.warnings)) {
        for (const w of approval.warnings as unknown[]) if (typeof w === 'string') toast(w, 'info');
      }

      if (changedRules.length > 0) {
        try {
          const { updated } = await reapplySupplierRules(invoice.client_id, changedRules);
          if (updated > 0) toast(ruleReappliedMessage(updated, { others: true }), 'info');
        } catch (reapplyErr) {
          console.error('[ValidationForm] Failed to re-apply supplier rule to invoices in review:', reapplyErr);
        }
      }
      onApproved();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  // "לא מאושר" opens a confirmation (with an optional reason); the dialog calls confirmReject
  const handleReject = () => { setError(''); setShowRejectDialog(true); };
  const confirmReject = async (reason: string) => {
    setRejecting(true); setError('');
    try {
      await rejectInvoice(invoice.id, reason);
      setShowRejectDialog(false);
      toast('החשבונית סומנה כלא מאושרת', 'info');
      onApproved();
    } catch (e) {
      setShowRejectDialog(false);
      setError(e instanceof Error ? e.message : 'שגיאה בסימון החשבונית כלא מאושרת');
    } finally {
      setRejecting(false);
    }
  };

  const isApproved = invoice.status === 'approved';
  const isRejected = invoice.status === 'rejected';
  const isError = invoice.status === 'error';
  const isReturned = invoice.status === 'returned';
  // While the pipeline runs it overwrites the fields, and the server refuses reject / split (409):
  // the form is read-only and offers no actions until the run ends (QA round 2, N23).
  const isProcessing = invoice.status === 'processing';
  const isReadOnly = isApproved || isRejected || isError || isReturned || isProcessing || invoice.status === 'exported';
  const canApprove = APPROVABLE_STATUSES.includes(invoice.status);
  const canReject = REJECTABLE_STATUSES.includes(invoice.status);

  // Failed document ('error'): process again, mark as not approved, or delete.
  const handleRetry = async () => {
    setErrorAction('retry'); setError('');
    try {
      await retryInvoice(invoice.id);
      toast('החשבונית נשלחה לעיבוד מחדש', 'info');
      onApproved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'שגיאה בהפעלת העיבוד מחדש');
    } finally {
      setErrorAction(null);
    }
  };

  // Explicit reopen back to review (exported: office owner only, logged on the server).
  const canReopen = REOPENABLE_STATUSES.includes(invoice.status);
  const handleReopen = async () => {
    const exported = invoice.status === 'exported';
    const question = exported
      ? 'החשבונית כבר יוצאה להנהלת החשבונות. פתיחה מחדש תאפשר לייצא אותה שוב (רישום כפול). להמשיך?'
      : 'לפתוח את החשבונית מחדש לבדיקה?';
    if (!(await askConfirm({ title: 'פתיחה מחדש לבדיקה', message: question, confirmLabel: 'פתח מחדש', tone: exported ? 'danger' : 'default' }))) return;
    setErrorAction('reopen'); setError('');
    try {
      await reopenInvoice(invoice.id);
      toast('החשבונית נפתחה מחדש לבדיקה', 'info');
      onApproved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'שגיאה בפתיחת החשבונית מחדש');
    } finally {
      setErrorAction(null);
    }
  };

  const handleDelete = async () => {
    if (!(await askConfirm({ title: 'מחיקת מסמך', message: `למחוק את המסמך "${invoice.file_name}"? לא ניתן לבטל פעולה זו.`, confirmLabel: 'מחק', tone: 'danger' }))) return;
    setErrorAction('delete'); setError('');
    try {
      await deleteInvoice(invoice.id);
      toast('המסמך נמחק', 'info');
      router.push('/review');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'שגיאה במחיקת החשבונית');
      setErrorAction(null);
    }
  };

  // The server already cleared the flag in validated_data; mirror it locally so approving
  // right after a dismissal doesn't write the stale duplicate flag back.
  const handleDuplicateDismissed = (otherInvoiceId: string) => {
    setData((prev) =>
      prev.validation_flags
        ? { ...prev, validation_flags: dismissDuplicateInFlags(prev.validation_flags, otherInvoiceId, prev.invoice_number) }
        : prev
    );
    onApproved();
  };

  const isApproveDisabled =
    saving ||
    rejecting ||
    !canApprove ||
    mathError ||
    !isVatIdOk ||
    isAllocationMissing ||
    isAllocationMalformed ||
    supplierStatus === 'loading' ||
    (supplierStatus === 'unknown' && !supplierCode.trim()) ||
    !!supplierCodeError ||
    !!categoryCodeError ||
    isDateEmpty ||
    isAmountBeforeVatEmpty ||
    isVatAmountEmpty ||
    isTotalAmountEmpty;

  return (
    // Mobile: the form flows with the page (no fixed-height box) and the action bar sticks to the
    // bottom of the screen. From lg it fills its pane: header and action bar stay put, and the
    // alerts scroll together with the fields, so banners never squeeze the fields into a sliver.
    <div className="lg:h-full flex flex-col" style={{ direction: 'rtl' }}>
      {/* Header */}
      <div className="px-5 py-4 border-b border-slate-100 bg-white">
        <h2 className="font-semibold text-slate-900 truncate"><bdi>{invoice.file_name}</bdi></h2>
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
        {lowConfidenceCount > 0 && (
          <p className="text-[11px] text-amber-700 mt-1">
            {countHe(lowConfidenceCount, 'field')} בביטחון נמוך — מסומנים בפס כתום
          </p>
        )}
      </div>

      <div className="lg:flex-1 lg:min-h-0 lg:overflow-y-auto">
      {/* Alerts */}
      {flags?.auto_approved && (
        <div className="mx-4 mt-3 flex items-center gap-2.5 p-3 bg-emerald-50 border border-emerald-200 rounded-xl text-sm text-emerald-800">
          <Zap className="h-4 w-4 shrink-0" />
          אושרה אוטומטית — הספק מוגדר לאישור אוטומטי וכל הבדיקות עברו
        </div>
      )}
      {!flags?.auto_approved && (flags?.auto_approve_blockers?.length ?? 0) > 0 && (
        <div className="mx-4 mt-3 flex items-start gap-2.5 p-3 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-700">
          <Zap className="h-4 w-4 shrink-0 mt-0.5 text-slate-400" />
          <div>
            <p className="font-medium">הספק מוגדר לאישור אוטומטי, אך החשבונית הועברה לבדיקה:</p>
            <ul className="list-disc pr-4 mt-1 text-xs text-slate-600 space-y-0.5">
              {flags?.auto_approve_blockers?.map((b, i) => <li key={i}>{b}</li>)}
            </ul>
          </div>
        </div>
      )}
      {/* The extracted VAT ID was the buyer's and no reliable issuer ID was found: until one is entered */}
      {!data.supplier_vat_id && flags?.rule_violations?.includes(BUYER_VAT_UNRESOLVED_VIOLATION) && (
        <div className="mx-4 mt-3 flex items-center gap-2.5 p-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {BUYER_VAT_UNRESOLVED_VIOLATION}
        </div>
      )}
      {!mathOk && (
        <div className="mx-4 mt-3 flex items-center gap-2.5 p-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
          <AlertCircle className="h-4 w-4 shrink-0" />
          סכומים לא מסתדרים — בדוק את הנתונים מול המסמך
        </div>
      )}
      <DuplicateAlert
        invoiceId={invoice.id}
        flags={data.validation_flags}
        readOnly={isReadOnly}
        onDismissed={handleDuplicateDismissed}
      />
      {warnings.map((w, i) => (
        <div key={i} className="mx-4 mt-2 flex items-start gap-2.5 p-3 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-800">
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          {w}
        </div>
      ))}

      {/* Tab Switcher Buttons */}
      <div className="px-4 py-2 bg-slate-50 border-b border-slate-100 flex gap-2 shrink-0 lg:sticky lg:top-0 lg:z-10">
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
      <div className="p-4 space-y-4">
        {activeFormTab === 'invoice' && (
          <div className="space-y-4 animate-in fade-in duration-200">
            <Field label="שם ספק" error={fieldError('supplier_name')} fieldKey="supplier_name" onFieldFocus={onFieldFocus} confidence={confidenceFor('supplier_name')}
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
                <label htmlFor="vf-supplier-code" className={clsx(
                  "text-xs shrink-0 font-semibold",
                  supplierCode.trim() ? "text-emerald-800" : "text-amber-800"
                )}>
                  קוד חשבון ספק:
                </label>
                <input
                  id="vf-supplier-code"
                  inputMode="numeric"
                  aria-invalid={!!supplierCodeError || undefined}
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
            {supplierCodeError && !isReadOnly && (
              <p className="text-xs text-red-600 -mt-2">{supplierCodeError}</p>
            )}

            <Field label="ח.פ. / עוסק מורשה" error={fieldError('supplier_vat_id') || !isVatIdOk} fieldKey="supplier_vat_id" onFieldFocus={onFieldFocus} confidence={confidenceFor('supplier_vat_id')}>
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
                              <span className="flex items-center gap-1.5">
                                {webSearchVat}
                                {!isReadOnly && !!data.supplier_vat_id &&
                                  normalizeVatId(webSearchVat) !== normalizeVatId(data.supplier_vat_id) && (
                                  <button
                                    type="button"
                                    onClick={async () => {
                                      if (!(await askConfirm({ title: 'החלפת ח.פ.', message: `להחליף את ח.פ. ${data.supplier_vat_id} במספר ${webSearchVat} שנמצא ברשם לפי שם הספק?`, confirmLabel: 'החלף' }))) return;
                                      set('supplier_vat_id', webSearchVat);
                                    }}
                                    className="font-sans text-[10px] text-blue-700 bg-blue-50 border border-blue-200 hover:bg-blue-100 px-1.5 py-0.5 rounded"
                                  >
                                    השתמש
                                  </button>
                                )}
                              </span>
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
              <Field label="מספר חשבונית" error={fieldError('invoice_number')} fieldKey="invoice_number" onFieldFocus={onFieldFocus} confidence={confidenceFor('invoice_number')}>
                <input
                  className={clsx('input-base disabled:opacity-75 disabled:bg-slate-50/80 disabled:cursor-not-allowed', fieldError('invoice_number') && 'input-error')}
                  value={data.invoice_number ?? ''}
                  onChange={(e) => set('invoice_number', e.target.value)}
                  onFocus={() => onFieldFocus?.('invoice_number')}
                  onBlur={() => onFieldFocus?.(null)}
                  disabled={isReadOnly}
                />
                {(data.invoice_number ?? '').trim().length > MOVEIN_INVOICE_NUMBER_WIDTH && (
                  <p className="text-xs text-amber-700 mt-1">
                    ארוך מ-{MOVEIN_INVOICE_NUMBER_WIDTH} תווים: ייצוא ל-Move-in ידלג על החשבונית (מערכות אחרות אינן מושפעות)
                  </p>
                )}
              </Field>

              <Field label="תאריך חשבונית" error={fieldError('invoice_date') || isDateEmpty} fieldKey="invoice_date" onFieldFocus={onFieldFocus} confidence={confidenceFor('invoice_date')}>
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

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <Field label="לפני מע״מ" error={mathError || isAmountBeforeVatEmpty} fieldKey="amount_before_vat" onFieldFocus={onFieldFocus} confidence={confidenceFor('amount_before_vat')}>
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
              <Field label='מע"מ' error={mathError || isVatAmountEmpty} fieldKey="vat_amount" onFieldFocus={onFieldFocus} confidence={confidenceFor('vat_amount')}>
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
              <Field label="סה״כ לתשלום" error={mathError || isTotalAmountEmpty} fieldKey="total_amount" onFieldFocus={onFieldFocus} confidence={confidenceFor('total_amount')}>
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

            <Field label="מספר הקצאה" error={isAllocationMissing} fieldKey="allocation_number" onFieldFocus={onFieldFocus} confidence={confidenceFor('allocation_number')}>
              <input
                className={clsx('input-base disabled:opacity-75 disabled:bg-slate-50/80 disabled:cursor-not-allowed', isAllocationMissing && 'input-error')}
                value={data.allocation_number ?? ''}
                onChange={(e) => set('allocation_number', e.target.value || null)}
                onFocus={() => onFieldFocus?.('allocation_number')}
                onBlur={() => onFieldFocus?.(null)}
                inputMode="numeric"
                placeholder={allocationRequired ? 'חובה בחשבונית זו' : 'לא חובה'}
                disabled={isReadOnly}
              />
            </Field>
            {isAllocationMissing && (
              <p className="text-xs text-amber-700">
                חשבונית מעל ₪{allocationThreshold(data.invoice_date)?.toLocaleString()} לפני מע"מ — בלי מספר הקצאה לא ניתן לקזז את המע"מ
              </p>
            )}
            {isAllocationMalformed && <p className="text-xs text-red-600">מספר הקצאה חייב להיות 9 ספרות</p>}

            <Field label="קטגוריית הוצאה" error={fieldError('expense_category')} fieldKey="expense_category" onFieldFocus={onFieldFocus} confidence={confidenceFor('expense_category')}
              badge={isCategoryFromRule
                ? <span className="flex items-center gap-1 text-xs text-indigo-700 bg-indigo-50 border border-indigo-200 px-2 py-0.5 rounded-full font-medium" title="ברירת המחדל שהוגדרה לספק במיפוי החשבונות">
                    <CheckCircle2 className="h-3 w-3" /> לפי כלל ספק
                  </span>
                : null}
            >
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
            {canSaveCategoryAsDefault && !isReadOnly && (
              <label className="flex items-center gap-2 -mt-2 px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-700 cursor-pointer animate-in fade-in duration-200">
                <input
                  type="checkbox"
                  className="rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                  checked={saveCategoryAsDefault}
                  onChange={(e) => setSaveCategoryAsDefault(e.target.checked)}
                />
                שמור כקטגוריית ברירת המחדל של הספק (יוחל גם על חשבוניות הספק הממתינות לבדיקה)
              </label>
            )}
            {categoryStatus === 'unknown' && data.expense_category && !isReadOnly && (
              <div className="flex items-center gap-2 -mt-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg animate-in fade-in duration-200">
                <AlertTriangle className="h-3.5 w-3.5 text-amber-500 shrink-0" />
                <label htmlFor="vf-category-code" className="text-xs text-amber-800 shrink-0">קוד חשבון קטגוריה:</label>
                <input
                  id="vf-category-code"
                  inputMode="numeric"
                  aria-invalid={!!categoryCodeError || undefined}
                  className="input-base py-1 text-sm font-mono flex-1 disabled:opacity-75 disabled:bg-slate-50/80"
                  placeholder="לדוג׳ 4001 — ריק = ייצוא ייחסם"
                  value={categoryCode}
                  onChange={(e) => setCategoryCode(e.target.value)}
                  disabled={isReadOnly}
                />
              </div>
            )}
            {categoryCodeError && !isReadOnly && (
              <p className="text-xs text-red-600 -mt-2">{categoryCodeError}</p>
            )}

            {initialLineItems.length > 0 && (
              <LineItemsTable
                items={data.line_items ?? []}
                amountBeforeVat={data.amount_before_vat}
                totalAmount={data.total_amount}
                onChange={isReadOnly ? undefined : (items: LineItem[]) => set('line_items', items)}
              />
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
      </div>

      {/* Footer */}
      <div className="px-4 py-4 border-t border-slate-100 bg-white sticky bottom-0 z-10 lg:static shadow-[0_-4px_12px_-8px_rgba(15,23,42,0.25)] lg:shadow-none">
        {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
        
        {isReadOnly ? (
          <div className="w-full flex items-center justify-center p-3.5 rounded-xl border text-sm font-semibold">
            {isProcessing && (
              <span className="text-blue-700 bg-blue-50 border-blue-200 flex items-center gap-2 px-3 py-1 rounded-full border">
                <RotateCcw className="h-4 w-4 shrink-0" /> החשבונית בעיבוד - אפשר לערוך, לאשר או לפצל אותה כשהעיבוד יסתיים
              </span>
            )}
            {isApproved && (
              <span className="text-emerald-700 bg-emerald-50 border-emerald-200 flex items-center gap-2 px-3 py-1 rounded-full border">
                <CheckCircle className="h-4 w-4" /> חשבונית זו אושרה
              </span>
            )}
            {isRejected && (
              <div className="flex flex-col items-center gap-2">
                <span className="text-rose-700 bg-rose-50 border-rose-200 flex items-center gap-2 px-3 py-1 rounded-full border">
                  <XCircle className="h-4 w-4" /> חשבונית זו לא אושרה
                </span>
                {invoice.reject_reason && (
                  <p className="text-xs font-normal text-slate-600 text-center break-words max-w-full" dir="auto">
                    סיבה: {invoice.reject_reason}
                  </p>
                )}
              </div>
            )}
            {isError && (
              <div className="w-full flex flex-col items-center gap-3">
                <span className="text-red-700 bg-red-50 border-red-200 flex items-center gap-2 px-3 py-1 rounded-full border">
                  <XCircle className="h-4 w-4 shrink-0" /> {invoice.error_message ? toUserErrorMessage(invoice.error_message) : 'המסמך לא זוהה כחשבונית'}
                </span>
                <div className="flex flex-wrap items-center justify-center gap-2">
                  <button
                    type="button"
                    onClick={handleRetry}
                    disabled={errorAction !== null || rejecting}
                    className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full border border-blue-200 text-blue-700 bg-white hover:bg-blue-50 transition-colors disabled:opacity-60"
                  >
                    <RotateCcw className="h-3.5 w-3.5" /> {errorAction === 'retry' ? 'שולח לעיבוד...' : 'עבד מחדש'}
                  </button>
                  <button
                    type="button"
                    onClick={handleReject}
                    disabled={errorAction !== null || rejecting}
                    className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full border border-rose-200 text-rose-700 bg-white hover:bg-rose-50 transition-colors disabled:opacity-60"
                  >
                    <XCircle className="h-3.5 w-3.5" /> {rejecting ? 'פוסל...' : 'לא מאושר'}
                  </button>
                  <button
                    type="button"
                    onClick={handleDelete}
                    disabled={errorAction !== null || rejecting}
                    className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full border border-slate-200 text-slate-600 bg-white hover:bg-slate-50 transition-colors disabled:opacity-60"
                  >
                    <Trash2 className="h-3.5 w-3.5" /> {errorAction === 'delete' ? 'מוחק...' : 'מחק מסמך'}
                  </button>
                </div>
              </div>
            )}
            {isReturned && (
              <span className="text-orange-700 bg-orange-50 border-orange-200 flex items-center gap-2 px-3 py-1 rounded-full border">
                <Undo2 className="h-4 w-4" /> חשבונית זו הוחזרה ללקוח
              </span>
            )}
            {invoice.status === 'exported' && (
              <span className="text-slate-600 bg-slate-50 border-slate-200 flex items-center gap-2 px-3 py-1 rounded-full border">
                <CheckCircle className="h-4 w-4" /> חשבונית זו כבר יוצאה
              </span>
            )}
            {onReturnToClient && (
              <button
                type="button"
                onClick={onReturnToClient}
                className="mr-3 flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full border border-orange-200 text-orange-700 bg-white hover:bg-orange-50 transition-colors"
              >
                <Undo2 className="h-3.5 w-3.5" /> החזר ללקוח
              </button>
            )}
            {canReopen && (
              <button
                type="button"
                onClick={handleReopen}
                disabled={errorAction !== null}
                className="mr-3 flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full border border-slate-200 text-slate-700 bg-white hover:bg-slate-50 transition-colors disabled:opacity-60"
              >
                <RotateCcw className="h-3.5 w-3.5" /> {errorAction === 'reopen' ? 'פותח...' : 'פתח מחדש לבדיקה'}
              </button>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-3">
            {onReturnToClient && (
              <button
                type="button"
                onClick={onReturnToClient}
                disabled={saving || rejecting}
                className="flex-1 py-3 bg-white border border-orange-200 hover:bg-orange-50 text-orange-700 font-semibold text-sm rounded-xl transition-colors disabled:opacity-60 flex items-center justify-center gap-2 shadow-sm"
              >
                <Undo2 className="h-4 w-4" /> החזר ללקוח
              </button>
            )}
            <button
              onClick={handleReject}
              disabled={saving || rejecting || !canReject}
              className="flex-1 py-3 bg-white border border-rose-200 hover:bg-rose-50 text-rose-700 font-semibold text-sm rounded-xl transition-colors disabled:opacity-60 flex items-center justify-center gap-2 shadow-sm"
            >
              {rejecting ? 'פוסל...' : 'לא מאושר'}
            </button>
            <button
              onClick={() => handleApprove()}
              disabled={isApproveDisabled}
              className="flex-1 py-3 bg-blue-600 hover:bg-blue-700 text-white font-semibold text-sm rounded-xl shadow-sm transition-colors disabled:opacity-60 flex items-center justify-center gap-2"
            >
              {saving ? 'מאשר...' : 'אשר חשבונית'}
            </button>
          </div>
        )}
      </div>

      {showRejectDialog && (
        <RejectDialog
          fileName={invoice.file_name}
          busy={rejecting}
          onConfirm={confirmReject}
          onClose={() => setShowRejectDialog(false)}
        />
      )}
    </div>
  );
}

function Field({ label, error, fieldKey, onFieldFocus, badge, confidence, children }: {
  label: string;
  error: boolean;
  fieldKey?: string;
  onFieldFocus?: (field: string | null) => void;
  badge?: React.ReactNode;
  /** Model confidence 0-1; null/undefined = not reported (old records) or value edited. */
  confidence?: number | null;
  children: React.ReactNode;
}) {
  const lowConfidence = isLowConfidence(confidence);
  const pct = confidence != null ? Math.round(confidence * 100) : null;
  // Tie the label to the field's input (first input / select / textarea child) for screen readers
  const inputId = fieldKey ? `vf-${fieldKey}` : undefined;
  let labelled = false;
  const content = Children.map(children, (child) => {
    if (
      !labelled && inputId && isValidElement<{ id?: string }>(child) &&
      typeof child.type === 'string' && ['input', 'select', 'textarea'].includes(child.type) && !child.props.id
    ) {
      labelled = true;
      return cloneElement(child, { id: inputId });
    }
    return child;
  });
  return (
    <div
      onMouseEnter={() => fieldKey && onFieldFocus?.(fieldKey)}
      onMouseLeave={() => onFieldFocus?.(null)}
      className={clsx(lowConfidence && !error && 'border-r-2 border-amber-400 pr-2 -mr-2.5')}
    >
      <div className="flex items-center justify-between gap-1.5 mb-1.5">
        <label htmlFor={labelled ? inputId : undefined} className={clsx('text-sm font-semibold flex items-center gap-1.5 min-w-0', error ? 'text-red-600' : 'text-slate-700')}>
          <span className="truncate">{label}{error && <span className="text-red-500 mr-0.5">*</span>}</span>
          {pct != null && (
            lowConfidence ? (
              <span
                className="shrink-0 text-[10px] font-medium text-amber-700 bg-amber-50 border border-amber-200 px-1.5 rounded-full"
                title="ה-AI לא בטוח בשדה זה — בדוק מול המסמך"
              >
                {pct}%
              </span>
            ) : (
              <span className="shrink-0 text-[10px] font-normal text-slate-400" title="רמת ביטחון ה-AI בשדה">
                {pct}%
              </span>
            )
          )}
        </label>
        {badge}
      </div>
      {content}
    </div>
  );
}
