'use client';

import { useEffect, useMemo, useState, useRef } from 'react';
import { createClient } from '@/utils/supabase/client';
import { AccountMapping, Client, MappingType, SupplierAutomationStatus } from '@/shared/types';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { fetchSupplierAutomation, reapplySupplierRules, setSupplierAutoApprove } from '@/lib/api';
import { normalizeVatId } from '@/shared/supplierRules';
import { AUTO_APPROVE_HISTORY_SIZE } from '@/shared/autoApprove';
import { normalizeVatId as toNineDigitVatId } from '@/shared/vatId';
import {
  accountCodeError,
  mappingDbErrorMessage,
  supplierVatIdError,
  validateMappingInput,
  type MappingErrors,
} from '@/shared/mappingValidation';
import { Plus, Trash2, Info, Upload, Loader2, X, ChevronLeft, ChevronRight, Users, Tag, Pencil, Zap } from 'lucide-react';
import clsx from 'clsx';
import { clientDisplayNames } from '@/shared/clientLabels';
import { LearnedRulesPanel } from '@/components/LearnedRulesPanel';

function getPageNumbers(currentPage: number, totalPages: number) {
  const pages: (number | string)[] = [];
  if (totalPages <= 5) {
    for (let i = 1; i <= totalPages; i++) {
      pages.push(i);
    }
  } else {
    if (currentPage <= 3) {
      pages.push(1, 2, 3, 4, '...', totalPages);
    } else if (currentPage >= totalPages - 2) {
      pages.push(1, '...', totalPages - 3, totalPages - 2, totalPages - 1, totalPages);
    } else {
      pages.push(1, '...', currentPage - 1, currentPage, currentPage + 1, '...', totalPages);
    }
  }
  return pages;
}

export default function MappingsPage() {
  const supabase = createClient();
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  const [clients, setClients] = useState<Client[]>([]);
  const clientLabels = useMemo(() => clientDisplayNames(clients), [clients]);
  const [selectedClient, setSelectedClient] = useState<string>('');
  const [mappings, setMappings] = useState<AccountMapping[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [type, setType] = useState<MappingType>('supplier');
  const [key, setKey] = useState('');
  const [code, setCode] = useState('');
  const [activeTab, setActiveTab] = useState<'supplier' | 'category'>('supplier');

  // Sync type with active tab
  useEffect(() => {
    setType(activeTab);
  }, [activeTab]);
  
  // Extra fields for suppliers
  const [supplierNumber, setSupplierNumber] = useState('');
  const [vatId, setVatId] = useState('');
  const [expenseCategory, setExpenseCategory] = useState('');
  
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formErrors, setFormErrors] = useState<MappingErrors>({});
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState('');
  const [categories, setCategories] = useState<string[]>([]);

  // Auto-approve eligibility + opt-in per supplier VAT ID
  const [automation, setAutomation] = useState<Map<string, SupplierAutomationStatus>>(new Map());
  const [historySize, setHistorySize] = useState(AUTO_APPROVE_HISTORY_SIZE);
  const [togglingVat, setTogglingVat] = useState<string | null>(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const ITEMS_PER_PAGE = 10;

  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery, selectedClient]);

  useEffect(() => {
    supabase.from('clients').select('*').order('name').then(({ data }) => {
      setClients(data ?? []);
      if (data?.length) setSelectedClient(data[0].id);
    });
  }, []);

  const loadMappings = async (clientId: string) => {
    const { data } = await supabase
      .from('account_mappings')
      .select('*')
      .eq('client_id', clientId)
      .order('mapping_type')
      .order('key');
    const loaded = (data as AccountMapping[]) ?? [];
    setMappings(loaded);
    
    // Extract categories list for drop-down
    const cats = loaded
      .filter((m) => m.mapping_type === 'category')
      .map((m) => m.key);
    setCategories(cats.length > 0 ? cats : [
      'ציוד משרדי', 'שכ"ד', 'תקשורת', 'שיווק ופרסום',
      'נסיעות', 'אחזקה', 'שירותים מקצועיים', 'חשמל ומים', 'אחר'
    ]);
  };

  const loadAutomation = async (clientId: string) => {
    try {
      const res = await fetchSupplierAutomation(clientId);
      setHistorySize(res.historySize);
      setAutomation(new Map(res.suppliers.map((s) => [s.supplier_vat_id, s])));
    } catch (err) {
      console.error('[Mappings] Failed to load auto-approve status:', err);
      setAutomation(new Map());
    }
  };

  useEffect(() => {
    if (selectedClient) {
      loadMappings(selectedClient);
      loadAutomation(selectedClient);
    }
  }, [selectedClient]);

  /** Re-applies supplier rules to the client's invoices still in review (validated_data only). */
  const reapplyRules = async (suppliers?: { name?: string | null; vatId?: string | null }[]) => {
    try {
      const { updated } = await reapplySupplierRules(selectedClient, suppliers);
      if (updated > 0) toast(`כללי הספק הוחלו על ${updated} חשבוניות הממתינות לבדיקה`, 'info');
    } catch (err) {
      console.error('[Mappings] Failed to re-apply supplier rules:', err);
      toast('המיפוי נשמר, אך עדכון החשבוניות הממתינות לבדיקה נכשל', 'error');
    }
  };

  const resetForm = () => {
    setKey(''); setCode(''); setSupplierNumber(''); setVatId(''); setExpenseCategory('');
    setEditingId(null);
    setFormErrors({});
  };

  const handleEdit = (m: AccountMapping) => {
    setActiveTab(m.mapping_type);
    setType(m.mapping_type);
    setKey(m.key);
    setCode(m.account_code ?? '');
    setSupplierNumber(m.supplier_number ?? '');
    setVatId(m.vat_id ?? '');
    setExpenseCategory(m.expense_category ?? '');
    setEditingId(m.id);
    setShowForm(true);
  };

  const handleAdd = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (saving) return;
    // Account codes feed the exports and the VAT ID is the rule's match key: validate before saving
    const errors = validateMappingInput({ mapping_type: type, key, account_code: code, vat_id: vatId });
    setFormErrors(errors);
    if (Object.keys(errors).length > 0) {
      toast(Object.values(errors)[0] ?? 'יש לתקן את השדות המסומנים', 'error');
      return;
    }
    setSaving(true);
    const values = {
      mapping_type: type,
      key: key.trim(),
      account_code: code.trim(),
      supplier_number: type === 'supplier' ? supplierNumber.trim() || null : null,
      // Stored as 9 digits (8-digit IDs get their leading zero), like the review form does
      vat_id: type === 'supplier' ? toNineDigitVatId(vatId) : null,
      expense_category: type === 'supplier' ? expenseCategory || null : null,
    };
    const wasEditing = !!editingId;
    const previous = editingId ? mappings.find((m) => m.id === editingId) : undefined;
    const { error: saveErr } = editingId
      ? await supabase.from('account_mappings').update(values).eq('id', editingId)
      : await supabase.from('account_mappings').insert({ client_id: selectedClient, ...values });
    setSaving(false);
    if (saveErr) {
      console.error('[Mappings] Failed to save mapping:', saveErr);
      toast(mappingDbErrorMessage(saveErr) ?? 'שמירת המיפוי נכשלה', 'error');
      return;
    }
    resetForm();
    setShowForm(false);
    // Show the saved row: switch to its tab and clear a search that could hide it
    setActiveTab(values.mapping_type);
    setSearchQuery('');
    await loadMappings(selectedClient);
    toast(wasEditing ? 'המיפוי עודכן' : 'המיפוי נשמר', 'success');
    if (values.mapping_type === 'supplier') loadAutomation(selectedClient);

    // A saved / changed supplier rule applies to that supplier's invoices still in review
    if (values.mapping_type === 'supplier' || previous?.mapping_type === 'supplier') {
      await reapplyRules([
        { name: values.key, vatId: values.vat_id },
        ...(previous ? [{ name: previous.key, vatId: previous.vat_id ?? null }] : []),
      ]);
    }
  };

  const handleToggleAutoApprove = async (vat: string, enabled: boolean) => {
    setTogglingVat(vat);
    try {
      await setSupplierAutoApprove(selectedClient, vat, enabled);
      toast(enabled ? 'אישור אוטומטי הופעל לספק' : 'אישור אוטומטי כובה לספק', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'שגיאה בעדכון האישור האוטומטי', 'error');
    } finally {
      setTogglingVat(null);
      loadAutomation(selectedClient);
    }
  };

  const handleImportExcel = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !selectedClient) return;

    setImporting(true);
    setImportError('');

    try {
      const XLSX = await import('xlsx');
      const reader = new FileReader();

      reader.onload = async (evt) => {
        try {
          const data = evt.target?.result;
          if (!data) throw new Error('שגיאה בקריאת הקובץ');

          const wb = XLSX.read(data, { type: 'array' });
          const wsname = wb.SheetNames[0];
          const ws = wb.Sheets[wsname];
          const rawData = XLSX.utils.sheet_to_json(ws, { header: 1 }) as any[][];

          if (rawData.length === 0) {
            throw new Error('הקובץ ריק');
          }

          // Read headers dynamically by scanning the first 10 rows for any known column header
          let headerRowIndex = 0;
          for (let i = 0; i < Math.min(rawData.length, 10); i++) {
            const row = rawData[i];
            if (!row) continue;
            const hasHeader = row.some(cell => {
              const str = String(cell || '').trim();
              return str === 'שם הספק' || str === 'שם ספק' || str === 'מספר כרטיס' || str === 'מספר ספק' || str === 'מספר' || str === 'מספר תיק מע"מ' || str === 'ח.פ';
            });
            if (hasHeader) {
              headerRowIndex = i;
              break;
            }
          }

          const headers = rawData[headerRowIndex].map(h => String(h || '').trim());

          // Map column indices
          const colIndex = {
            supplier_number: headers.findIndex(h => h === 'מספר'),
            key: headers.findIndex(h => h === 'שם הספק' || h === 'שם ספק'),
            vat_id: headers.findIndex(h => h === 'מספר תיק מע"מ' || h === 'ח.פ' || h === 'ח.פ.'),
            account_code: headers.findIndex(h => h === 'מספר כרטיס' || h === 'קוד כרטיס' || h === 'קוד חשבון'),
            expense_category: headers.findIndex(h => h === 'שם הוצאה' || h === 'קטגוריה'),
          };

          // Validate that we have at least the supplier name column
          if (colIndex.key === -1) {
            throw new Error('עמודת "שם הספק" לא נמצאה בקובץ. אנא ודא שהכותרות תואמות לעמודות הנדרשות.');
          }

          const parsedRows: Partial<AccountMapping>[] = [];
          const invalidRows: string[] = [];
          for (let i = headerRowIndex + 1; i < rawData.length; i++) {
            const row = rawData[i];
            if (!row || row.length === 0) continue;

            const name = colIndex.key !== -1 && row[colIndex.key] != null ? String(row[colIndex.key]).trim() : '';
            if (!name) continue; // Skip empty rows

            const supplier_number = colIndex.supplier_number !== -1 && row[colIndex.supplier_number] != null 
              ? String(row[colIndex.supplier_number]).trim() 
              : null;
            const vat_id = colIndex.vat_id !== -1 && row[colIndex.vat_id] != null 
              ? String(row[colIndex.vat_id]).trim() 
              : null;
            const account_code = colIndex.account_code !== -1 && row[colIndex.account_code] != null 
              ? String(row[colIndex.account_code]).trim() 
              : '';
            const expense_category = colIndex.expense_category !== -1 && row[colIndex.expense_category] != null 
              ? String(row[colIndex.expense_category]).trim() 
              : null;

            // Same checks as the mappings form; an invalid row is skipped and reported
            const rowError = accountCodeError(account_code) ?? supplierVatIdError(vat_id);
            if (rowError) {
              invalidRows.push(`שורה ${i + 1} (${name}): ${rowError}`);
              continue;
            }

            parsedRows.push({
              client_id: selectedClient,
              mapping_type: 'supplier',
              key: name,
              account_code,
              supplier_number,
              vat_id: toNineDigitVatId(vat_id),
              expense_category,
            });
          }

          if (parsedRows.length === 0) {
            throw new Error(
              invalidRows.length > 0
                ? `לא נמצאו שורות תקינות לייבוא. ${invalidRows.slice(0, 5).join('; ')}`
                : 'לא נמצאו שורות תקינות לייבוא'
            );
          }

          // Fetch existing mappings to avoid duplicates
          const { data: existing } = await supabase
            .from('account_mappings')
            .select('*')
            .eq('client_id', selectedClient)
            .eq('mapping_type', 'supplier');

          const existingMap = new Map((existing || []).map(m => [m.key, m]));

          // Insert or update in database
          const toInsert: any[] = [];
          const toUpdate: { id: string; data: any }[] = [];

          for (const item of parsedRows) {
            const match = existingMap.get(item.key!);
            if (match) {
              toUpdate.push({
                id: match.id,
                data: {
                  account_code: item.account_code || match.account_code,
                  supplier_number: item.supplier_number || match.supplier_number,
                  vat_id: item.vat_id || match.vat_id,
                  expense_category: item.expense_category || match.expense_category,
                }
              });
            } else {
              toInsert.push(item);
            }
          }

          // Perform updates and inserts in database
          if (toInsert.length > 0) {
            const { error: insErr } = await supabase.from('account_mappings').insert(toInsert);
            if (insErr) {
              console.error('[Mappings] Excel import insert failed:', insErr);
              throw new Error(mappingDbErrorMessage(insErr) ?? 'שמירת הספקים מהקובץ נכשלה');
            }
          }

          for (const upd of toUpdate) {
            const { error: updErr } = await supabase
              .from('account_mappings')
              .update(upd.data)
              .eq('id', upd.id);
            if (updErr) {
              console.error('[Mappings] Excel import update failed:', updErr);
              throw new Error(mappingDbErrorMessage(updErr) ?? 'עדכון הספקים מהקובץ נכשל');
            }
          }

          // Refresh mappings
          await loadMappings(selectedClient);
          loadAutomation(selectedClient);
          toast(`יובאו בהצלחה ${parsedRows.length} ספקים (${toInsert.length} חדשים, ${toUpdate.length} עודכנו)`, 'success');
          if (invalidRows.length > 0) {
            setImportError(
              `${invalidRows.length} שורות לא יובאו: ${invalidRows.slice(0, 5).join('; ')}${invalidRows.length > 5 ? ' ...' : ''}`
            );
          }
          // Imported rules apply to every invoice still in review
          reapplyRules();
        } catch (err: any) {
          console.error(err);
          setImportError(err.message || 'שגיאה בפענוח קובץ האקסל');
        }
      };

      reader.readAsArrayBuffer(file);
    } catch (err: any) {
      console.error(err);
      setImportError('שגיאה בטעינת ספריית האקסל');
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = ''; // Reset file input
    }
  };

  const handleDelete = async (id: string) => {
    const deleted = mappings.find((m) => m.id === id);
    await supabase.from('account_mappings').delete().eq('id', id);
    setMappings((prev) => prev.filter((m) => m.id !== id));
    // Invoices in review that took values from this rule fall back to another rule or the AI values
    if (deleted?.mapping_type === 'supplier') {
      await reapplyRules([{ name: deleted.key, vatId: deleted.vat_id ?? null }]);
    }
  };

  const supplierMappings = mappings.filter((m) => m.mapping_type === 'supplier');
  const categoryMappings = mappings.filter((m) => m.mapping_type === 'category');

  // Filter supplier mappings by search query
  const filteredSuppliers = supplierMappings.filter((m) => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase().trim();
    return (
      m.key.toLowerCase().includes(q) ||
      (m.supplier_number && m.supplier_number.toLowerCase().includes(q)) ||
      (m.vat_id && m.vat_id.toLowerCase().includes(q)) ||
      (m.account_code && m.account_code.toLowerCase().includes(q)) ||
      (m.expense_category && m.expense_category.toLowerCase().includes(q))
    );
  });

  const totalItems = filteredSuppliers.length;
  const totalPages = Math.ceil(totalItems / ITEMS_PER_PAGE);
  const safeCurrentPage = Math.min(currentPage, Math.max(1, totalPages));
  const startIndex = (safeCurrentPage - 1) * ITEMS_PER_PAGE;
  const endIndex = startIndex + ITEMS_PER_PAGE;
  const paginatedSuppliers = filteredSuppliers.slice(startIndex, endIndex);

  return (
    <div className="space-y-6 max-w-5xl">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-2xl font-bold text-slate-900">מיפוי חשבונות</h2>
          <p className="text-sm text-slate-500 mt-1">קוד ספק וקטגוריה לייצוא Move-in</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={() => fileInputRef.current?.click()} disabled={!selectedClient || importing}>
            {importing ? <Loader2 className="h-4 w-4 animate-spin ml-1" /> : <Upload className="h-4 w-4 ml-1" />}
            {importing ? 'מייבא...' : 'יבוא מאקסל'}
          </Button>
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleImportExcel}
            accept=".xlsx,.xls,.csv"
            className="hidden"
          />
          <Button onClick={() => { resetForm(); setShowForm(true); }} disabled={!selectedClient}>
            <Plus className="h-4 w-4" /> הוסף מיפוי
          </Button>
        </div>
      </div>

      {importError && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-xl text-sm text-red-800">
          {importError}
        </div>
      )}

      {/* Info box */}
      <div className="flex gap-3 p-4 bg-blue-50 border border-blue-200 rounded-xl text-sm text-blue-800">
        <Info className="h-4 w-4 shrink-0 mt-0.5 text-blue-500" />
        <div className="space-y-1">
          <p><strong>ספק</strong> — קוד פנימי בתוכנת הנהלת החשבונות (לא ח.פ.). לדוגמה: אופיס דיפו → <code className="bg-blue-100 px-1.5 py-0.5 rounded text-xs font-mono">2340</code></p>
          <p><strong>כלל ספק</strong> — קטגוריית ברירת המחדל וקוד הכרטיס של הספק ממולאים אוטומטית בחשבוניות שלו (גם בחשבוניות שכבר ממתינות לבדיקה). עריכה ידנית של המבקר בחשבונית גוברת על הכלל.</p>
          <p><strong>אישור אוטומטי</strong> — ספק שב-{historySize} החשבוניות האחרונות שנבדקו לא נדרש בהן אף תיקון מסומן ככשיר. לאחר הפעלה, חשבוניות שעוברות את כל הבדיקות מאושרות ללא בדיקה ידנית; תיקון בחשבונית של הספק מכבה את האישור האוטומטי.</p>
          <p><strong>יבוא אקסל ספקים</strong> — העלה קובץ עם העמודות הבאות: <code className="bg-blue-100 px-1.5 py-0.5 rounded text-xs font-mono">מספר</code>, <code className="bg-blue-100 px-1.5 py-0.5 rounded text-xs font-mono">שם הספק</code>, <code className="bg-blue-100 px-1.5 py-0.5 rounded text-xs font-mono">מספר תיק מע"מ</code>, <code className="bg-blue-100 px-1.5 py-0.5 rounded text-xs font-mono">מספר כרטיס</code>, <code className="bg-blue-100 px-1.5 py-0.5 rounded text-xs font-mono">שם הוצאה</code>.</p>
        </div>
      </div>

      {/* Client selector */}
      <div className="flex items-center gap-3">
        <label htmlFor="mappings-client" className="text-sm font-medium text-slate-700 shrink-0">לקוח:</label>
        <select
          id="mappings-client"
          value={selectedClient}
          onChange={(e) => setSelectedClient(e.target.value)}
          className="input-base max-w-xs"
        >
          {clients.map((c) => <option key={c.id} value={c.id}>{clientLabels.get(c.id) ?? c.name}</option>)}
        </select>
      </div>

      {/* Rules learned from the reviewer's corrections */}
      {selectedClient && <LearnedRulesPanel clientId={selectedClient} />}

      {/* Add form */}
      {showForm && (
        <form className="card p-4 sm:p-5 space-y-4" onSubmit={handleAdd} noValidate>
          <h3 className="font-semibold text-slate-900">{editingId ? 'עריכת מיפוי' : 'מיפוי חדש'}</h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label htmlFor="mapping-type" className="block text-sm font-medium text-slate-700 mb-1.5">סוג</label>
              <select id="mapping-type" value={type} onChange={(e) => setType(e.target.value as MappingType)} className="input-base" disabled={!!editingId}>
                <option value="supplier">ספק</option>
                <option value="category">קטגוריה</option>
              </select>
            </div>
            <div>
              <label htmlFor="mapping-key" className="block text-sm font-medium text-slate-700 mb-1.5">
                {type === 'supplier' ? 'שם ספק' : 'שם קטגוריה'}
              </label>
              <input
                id="mapping-key"
                value={key} onChange={(e) => { setKey(e.target.value); setFormErrors((p) => ({ ...p, key: undefined })); }}
                placeholder={type === 'supplier' ? 'אופיס דיפו' : 'ציוד משרדי'}
                aria-invalid={!!formErrors.key || undefined}
                className={clsx('input-base', formErrors.key && 'input-error')}
              />
              {formErrors.key && <p className="text-xs text-red-600 mt-1">{formErrors.key}</p>}
            </div>
            <div>
              <label htmlFor="mapping-code" className="block text-sm font-medium text-slate-700 mb-1.5">
                {type === 'supplier' ? 'מספר כרטיס (קוד)' : 'קוד חשבון'}
              </label>
              <input
                id="mapping-code"
                value={code} onChange={(e) => { setCode(e.target.value); setFormErrors((p) => ({ ...p, account_code: undefined })); }}
                placeholder="4001"
                inputMode="numeric"
                aria-invalid={!!formErrors.account_code || undefined}
                className={clsx('input-base font-mono', formErrors.account_code && 'input-error')}
              />
              {formErrors.account_code && <p className="text-xs text-red-600 mt-1">{formErrors.account_code}</p>}
            </div>
          </div>

          {/* Supplier extra fields row */}
          {type === 'supplier' && (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label htmlFor="mapping-supplier-number" className="block text-sm font-medium text-slate-700 mb-1.5">מספר ספק</label>
                <input
                  id="mapping-supplier-number"
                  value={supplierNumber} onChange={(e) => setSupplierNumber(e.target.value)}
                  placeholder="למשל: 12"
                  className="input-base font-mono"
                />
              </div>
              <div>
                <label htmlFor="mapping-vat-id" className="block text-sm font-medium text-slate-700 mb-1.5">מספר תיק מע"מ</label>
                <input
                  id="mapping-vat-id"
                  value={vatId} onChange={(e) => { setVatId(e.target.value); setFormErrors((p) => ({ ...p, vat_id: undefined })); }}
                  placeholder="511234567"
                  inputMode="numeric"
                  aria-invalid={!!formErrors.vat_id || undefined}
                  className={clsx('input-base font-mono', formErrors.vat_id && 'input-error')}
                />
                {formErrors.vat_id && <p className="text-xs text-red-600 mt-1">{formErrors.vat_id}</p>}
              </div>
              <div>
                <label htmlFor="mapping-category" className="block text-sm font-medium text-slate-700 mb-1.5">שם הוצאה ברירת מחדל</label>
                <select
                  id="mapping-category"
                  value={expenseCategory} onChange={(e) => setExpenseCategory(e.target.value)}
                  className="input-base"
                >
                  <option value="">בחר קטגוריה...</option>
                  {categories.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            </div>
          )}

          <div className="flex gap-2 pt-1">
            <Button type="submit" disabled={saving || !key.trim() || !code.trim()}>
              {saving ? 'שומר...' : 'שמור'}
            </Button>
            <Button type="button" variant="secondary" onClick={() => {
              setShowForm(false);
              resetForm();
            }}>ביטול</Button>
          </div>
        </form>
      )}

      {/* Tabs Selection */}
      <div className="flex border-b border-slate-200" style={{ direction: 'rtl' }}>
        <button
          onClick={() => setActiveTab('supplier')}
          className={clsx(
            'flex items-center gap-2 px-3 sm:px-6 py-3 border-b-2 font-medium text-sm transition-all focus:outline-none',
            activeTab === 'supplier'
              ? 'border-blue-600 text-blue-600 font-semibold'
              : 'border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300'
          )}
        >
          <Users className="h-4 w-4" />
          <span>ספקים ({supplierMappings.length})</span>
        </button>
        <button
          onClick={() => setActiveTab('category')}
          className={clsx(
            'flex items-center gap-2 px-3 sm:px-6 py-3 border-b-2 font-medium text-sm transition-all focus:outline-none',
            activeTab === 'category'
              ? 'border-blue-600 text-blue-600 font-semibold'
              : 'border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300'
          )}
        >
          <Tag className="h-4 w-4" />
          <span>קטגוריות הוצאה ({categoryMappings.length})</span>
        </button>
      </div>

      {/* Tables layout */}
      <div className="space-y-6">
        {activeTab === 'supplier' && (
          /* Suppliers Table */
          <div className="card overflow-hidden">
            <div className="px-4 py-3.5 border-b border-slate-100 bg-slate-50/50 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3" style={{ direction: 'rtl' }}>
              <div>
                <p className="font-semibold text-slate-900">ספקים</p>
                <p className="text-xs text-slate-500 mt-0.5">פרטי ספקים ומיפוי כרטיסים</p>
              </div>
              
              {/* Search Input */}
              <div className="relative w-full sm:w-64">
                <input
                  type="text"
                  placeholder="חיפוש ספק, ח.פ., קוד..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full text-sm border border-slate-200 rounded-lg bg-white pl-8 pr-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 text-right font-medium"
                />
                {searchQuery && (
                  <button
                    onClick={() => setSearchQuery('')}
                    className="absolute inset-y-0 left-2.5 flex items-center text-slate-400 hover:text-slate-600"
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>
            </div>
            <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm text-right">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-100">
                  <th className="px-4 py-2.5 text-right text-xs font-semibold text-slate-500 uppercase tracking-wide">שם ספק</th>
                  <th className="px-4 py-2.5 text-right text-xs font-semibold text-slate-500 uppercase tracking-wide">מספר ספק</th>
                  <th className="px-4 py-2.5 text-right text-xs font-semibold text-slate-500 uppercase tracking-wide">מספר תיק מע"מ (ח.פ.)</th>
                  <th className="px-4 py-2.5 text-right text-xs font-semibold text-slate-500 uppercase tracking-wide">מספר כרטיס (קוד)</th>
                  <th className="px-4 py-2.5 text-right text-xs font-semibold text-slate-500 uppercase tracking-wide">שם הוצאה ברירת מחדל</th>
                  <th className="px-4 py-2.5 text-right text-xs font-semibold text-slate-500 uppercase tracking-wide">אישור אוטומטי</th>
                  <th className="px-4 py-2.5 w-16"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {paginatedSuppliers.map((m) => (
                  <tr key={m.id} className="hover:bg-slate-50/60 transition-colors group">
                    <td className="px-4 py-3 text-slate-900 font-medium">{m.key}</td>
                    <td className="px-4 py-3 text-slate-600 font-mono">{m.supplier_number || '-'}</td>
                    <td className="px-4 py-3 text-slate-600 font-mono">{m.vat_id || '-'}</td>
                    <td className="px-4 py-3">
                      <code className="bg-blue-50 text-blue-700 px-2 py-0.5 rounded text-xs font-mono">{m.account_code}</code>
                    </td>
                    <td className="px-4 py-3 text-slate-600">
                      {m.expense_category ? (
                        <span className="bg-slate-100 text-slate-700 px-2 py-0.5 rounded text-xs">
                          {m.expense_category}
                        </span>
                      ) : '-'}
                    </td>
                    <td className="px-4 py-3">
                      <AutoApproveCell
                        vatId={normalizeVatId(m.vat_id)}
                        status={automation.get(normalizeVatId(m.vat_id) ?? '')}
                        historySize={historySize}
                        busy={togglingVat === normalizeVatId(m.vat_id)}
                        onToggle={handleToggleAutoApprove}
                      />
                    </td>
                    <td className="px-4 py-3 text-center">
                      <div className="flex items-center justify-center gap-2 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 transition-opacity">
                        <button
                          onClick={() => handleEdit(m)}
                          className="text-slate-300 hover:text-blue-600 transition-colors"
                          title="עריכה"
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                        <button
                          onClick={() => handleDelete(m.id)}
                          className="text-slate-300 hover:text-red-500 transition-colors"
                          title="מחיקה"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {paginatedSuppliers.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-12 text-center text-slate-400">
                      {searchQuery ? 'לא נמצאו ספקים העונים לחיפוש' : 'אין מיפוי ספקים מוגדר'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            </div>

            {/* Pagination controls */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between border-t border-slate-200 bg-white px-4 py-3 sm:px-6" style={{ direction: 'rtl' }}>
                {/* Mobile layout */}
                <div className="flex flex-1 justify-between sm:hidden">
                  <button
                    onClick={() => setCurrentPage((prev) => Math.max(prev - 1, 1))}
                    disabled={safeCurrentPage === 1}
                    className="relative inline-flex items-center rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    הקודם
                  </button>
                  <button
                    onClick={() => setCurrentPage((prev) => Math.min(prev + 1, totalPages))}
                    disabled={safeCurrentPage === totalPages}
                    className="relative ml-3 inline-flex items-center rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    הבא
                  </button>
                </div>

                {/* Desktop layout */}
                <div className="hidden sm:flex sm:flex-1 sm:items-center sm:justify-between">
                  <div>
                    <p className="text-sm text-slate-700 gap-1 flex items-center">
                      מציג
                      <span className="font-semibold">{startIndex + 1}</span>
                      עד
                      <span className="font-semibold">{Math.min(endIndex, totalItems)}</span>
                      מתוך
                      <span className="font-semibold">{totalItems}</span>
                      תוצאות
                    </p>
                  </div>
                  <div>
                    <nav className="isolate inline-flex -space-x-px rounded-md shadow-sm gap-1" aria-label="Pagination">
                      <button
                        onClick={() => setCurrentPage((prev) => Math.max(prev - 1, 1))}
                        disabled={safeCurrentPage === 1}
                        className="relative inline-flex items-center rounded-lg border border-slate-200 bg-white p-2 text-slate-500 hover:bg-slate-50 focus:z-20 focus:outline-offset-0 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                      >
                        <span className="sr-only">הקודם</span>
                        <ChevronRight className="h-4 w-4" />
                      </button>
                      {/* Page numbers */}
                      {getPageNumbers(safeCurrentPage, totalPages).map((page, index) => {
                        if (page === '...') {
                          return (
                            <span
                              key={`ellipsis-${index}`}
                              className="relative inline-flex items-center px-3 py-2 text-sm font-semibold text-slate-500 focus:outline-offset-0"
                            >
                              ...
                            </span>
                          );
                        }
                        return (
                          <button
                            key={page}
                            onClick={() => setCurrentPage(page as number)}
                            className={`relative inline-flex items-center rounded-lg px-4 py-2 text-sm font-semibold transition-all ${
                              safeCurrentPage === page
                                ? 'bg-blue-600 text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600'
                                : 'text-slate-900 border border-slate-200 bg-white hover:bg-slate-50 focus:outline-offset-0'
                            }`}
                          >
                            {page}
                          </button>
                        );
                      })}
                      <button
                        onClick={() => setCurrentPage((prev) => Math.min(prev + 1, totalPages))}
                        disabled={safeCurrentPage === totalPages}
                        className="relative inline-flex items-center rounded-lg border border-slate-200 bg-white p-2 text-slate-500 hover:bg-slate-50 focus:z-20 focus:outline-offset-0 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                      >
                        <span className="sr-only">הבא</span>
                        <ChevronLeft className="h-4 w-4" />
                      </button>
                    </nav>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {activeTab === 'category' && (
          /* Expense Categories Table */
          <div className="card overflow-hidden">
            <div className="px-4 py-3.5 border-b border-slate-100 bg-slate-50/50">
              <p className="font-semibold text-slate-900">קטגוריות הוצאה</p>
              <p className="text-xs text-slate-500 mt-0.5">שם קטגוריה 🡨 קוד סעיף הוצאה</p>
            </div>
            <div className="overflow-x-auto">
            <table className="w-full text-sm text-right">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-100">
                  <th className="px-4 py-2.5 text-right text-xs font-semibold text-slate-500 uppercase tracking-wide">שם קטגוריה</th>
                  <th className="px-4 py-2.5 text-right text-xs font-semibold text-slate-500 uppercase tracking-wide">קוד חשבון</th>
                  <th className="px-4 py-2.5 w-16"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {categoryMappings.map((m) => (
                  <tr key={m.id} className="hover:bg-slate-50/60 transition-colors group">
                    <td className="px-4 py-3 text-slate-700">{m.key}</td>
                    <td className="px-4 py-3">
                      <code className="bg-slate-100 text-slate-600 px-2 py-0.5 rounded text-xs font-mono">{m.account_code || 'לא הוגדר'}</code>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 transition-opacity">
                        <button
                          onClick={() => handleEdit(m)}
                          className="text-slate-300 hover:text-blue-600 transition-colors"
                          title="עריכה"
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                        <button
                          onClick={() => handleDelete(m.id)}
                          className="text-slate-300 hover:text-red-500 transition-colors"
                          title="מחיקה"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {categoryMappings.length === 0 && (
                  <tr>
                    <td colSpan={3} className="px-4 py-8 text-center text-slate-400 text-sm">
                      <div className="space-y-2">
                        <p>אין מיפויים עדיין</p>
                        {selectedClient && (
                          <SeedCategoriesButton clientId={selectedClient} onDone={() => loadMappings(selectedClient)} />
                        )}
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            </div>
          </div>
        )}
      </div>

    </div>
  );
}

function AutoApproveCell({ vatId, status, historySize, busy, onToggle }: {
  vatId: string | null;
  status: SupplierAutomationStatus | undefined;
  historySize: number;
  busy: boolean;
  onToggle: (vatId: string, enabled: boolean) => void;
}) {
  if (!vatId) {
    return <span className="text-xs text-slate-400" title="אישור אוטומטי מזוהה לפי ח.פ. הספק">נדרש ח.פ.</span>;
  }

  const enabled = status?.auto_approve ?? false;
  const eligible = status?.eligible ?? false;
  const streak = Math.min(status?.clean_streak ?? 0, historySize);
  const revertedByCorrections = !enabled && status?.disabled_reason === 'corrections';
  // Turning it on needs an eligible supplier; turning it off is always allowed
  const canToggle = !busy && (enabled || eligible);

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label="אישור אוטומטי"
        disabled={!canToggle}
        onClick={() => onToggle(vatId, !enabled)}
        title={!enabled && !eligible ? `זמין לאחר ${historySize} חשבוניות שנבדקו ברצף ללא תיקונים` : undefined}
        className={clsx(
          'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500/30 disabled:cursor-not-allowed disabled:opacity-50',
          enabled ? 'bg-emerald-500' : 'bg-slate-200'
        )}
      >
        <span
          className={clsx(
            'inline-block h-4 w-4 rounded-full bg-white shadow transition-transform',
            enabled ? '-translate-x-[18px]' : '-translate-x-0.5'
          )}
        />
      </button>
      {busy ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-400" />
      ) : revertedByCorrections ? (
        <span className="text-xs text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full" title="תיקון בחשבונית שנבדקה כיבה את האישור האוטומטי">
          כובה עקב תיקון
        </span>
      ) : eligible ? (
        <span className="flex items-center gap-1 text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full font-medium">
          <Zap className="h-3 w-3" /> כשיר
        </span>
      ) : (
        <span className="text-xs text-slate-500" title="חשבוניות אחרונות שנבדקו ללא תיקונים">
          {streak}/{historySize} ללא תיקונים
        </span>
      )}
    </div>
  );
}

function SeedCategoriesButton({ clientId, onDone }: { clientId: string; onDone: () => void }) {
  const supabase = createClient();
  const [loading, setLoading] = useState(false);

  const handleSeed = async () => {
    setLoading(true);
    await supabase.from('account_mappings').insert(
      [
        'ציוד משרדי', 'שכ"ד', 'תקשורת', 'שיווק ופרסום',
        'נסיעות', 'אחזקה', 'שירותים מקצועיים', 'חשמל ומים', 'אחר',
      ].map((cat) => ({
        client_id: clientId,
        mapping_type: 'category',
        key: cat,
        account_code: '',
      }))
    );
    setLoading(false);
    onDone();
  };

  return (
    <button
      onClick={handleSeed}
      disabled={loading}
      className="text-blue-600 hover:text-blue-700 text-xs font-medium disabled:opacity-50 underline"
    >
      {loading ? 'מוסיף...' : '+ הוסף קטגוריות ברירת מחדל'}
    </button>
  );
}
