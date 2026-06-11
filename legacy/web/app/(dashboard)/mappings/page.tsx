'use client';

import { useEffect, useState, useRef } from 'react';
import { createClient } from '@/utils/supabase/client';
import { AccountMapping, Client, MappingType } from '@invoice/shared-types';
import { Button } from '@/components/ui/Button';
import { Plus, Trash2, Info, Upload, Loader2 } from 'lucide-react';

export default function MappingsPage() {
  const supabase = createClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  const [clients, setClients] = useState<Client[]>([]);
  const [selectedClient, setSelectedClient] = useState<string>('');
  const [mappings, setMappings] = useState<AccountMapping[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [type, setType] = useState<MappingType>('supplier');
  const [key, setKey] = useState('');
  const [code, setCode] = useState('');
  
  // Extra fields for suppliers
  const [supplierNumber, setSupplierNumber] = useState('');
  const [vatId, setVatId] = useState('');
  const [expenseCategory, setExpenseCategory] = useState('');
  
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState('');
  const [categories, setCategories] = useState<string[]>([]);

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

  useEffect(() => {
    if (selectedClient) loadMappings(selectedClient);
  }, [selectedClient]);

  const handleAdd = async () => {
    if (!key.trim() || !code.trim()) return;
    setSaving(true);
    await supabase.from('account_mappings').insert({
      client_id: selectedClient,
      mapping_type: type,
      key: key.trim(),
      account_code: code.trim(),
      supplier_number: type === 'supplier' ? supplierNumber.trim() || null : null,
      vat_id: type === 'supplier' ? vatId.trim() || null : null,
      expense_category: type === 'supplier' ? expenseCategory || null : null,
    });
    setKey(''); setCode(''); setSupplierNumber(''); setVatId(''); setExpenseCategory('');
    setShowForm(false); setSaving(false);
    loadMappings(selectedClient);
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

          // Read headers (first row)
          const headers = rawData[0].map(h => String(h || '').trim());

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
          for (let i = 1; i < rawData.length; i++) {
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

            parsedRows.push({
              client_id: selectedClient,
              mapping_type: 'supplier',
              key: name,
              account_code,
              supplier_number,
              vat_id,
              expense_category,
            });
          }

          if (parsedRows.length === 0) {
            throw new Error('לא נמצאו שורות תקינות לייבוא');
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
            if (insErr) throw insErr;
          }

          for (const upd of toUpdate) {
            const { error: updErr } = await supabase
              .from('account_mappings')
              .update(upd.data)
              .eq('id', upd.id);
            if (updErr) throw updErr;
          }

          // Refresh mappings
          loadMappings(selectedClient);
          alert(`יובאו בהצלחה ${parsedRows.length} ספקים! (${toInsert.length} חדשים, ${toUpdate.length} עודכנו)`);
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
    await supabase.from('account_mappings').delete().eq('id', id);
    setMappings((prev) => prev.filter((m) => m.id !== id));
  };

  const supplierMappings = mappings.filter((m) => m.mapping_type === 'supplier');
  const categoryMappings = mappings.filter((m) => m.mapping_type === 'category');

  return (
    <div className="space-y-6 max-w-5xl">
      {/* Header */}
      <div className="flex items-center justify-between">
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
          <Button onClick={() => setShowForm(true)} disabled={!selectedClient}>
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
          <p><strong>יבוא אקסל ספקים</strong> — העלה קובץ עם העמודות הבאות: <code className="bg-blue-100 px-1.5 py-0.5 rounded text-xs font-mono">מספר</code>, <code className="bg-blue-100 px-1.5 py-0.5 rounded text-xs font-mono">שם הספק</code>, <code className="bg-blue-100 px-1.5 py-0.5 rounded text-xs font-mono">מספר תיק מע"מ</code>, <code className="bg-blue-100 px-1.5 py-0.5 rounded text-xs font-mono">מספר כרטיס</code>, <code className="bg-blue-100 px-1.5 py-0.5 rounded text-xs font-mono">שם הוצאה</code>.</p>
        </div>
      </div>

      {/* Client selector */}
      <div className="flex items-center gap-3">
        <label className="text-sm font-medium text-slate-700 shrink-0">לקוח:</label>
        <select
          value={selectedClient}
          onChange={(e) => setSelectedClient(e.target.value)}
          className="input-base max-w-xs"
        >
          {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>

      {/* Add form */}
      {showForm && (
        <div className="card p-5 space-y-4">
          <h3 className="font-semibold text-slate-900">מיפוי חדש</h3>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">סוג</label>
              <select value={type} onChange={(e) => setType(e.target.value as MappingType)} className="input-base">
                <option value="supplier">ספק</option>
                <option value="category">קטגוריה</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">
                {type === 'supplier' ? 'שם ספק' : 'שם קטגוריה'}
              </label>
              <input
                value={key} onChange={(e) => setKey(e.target.value)}
                placeholder={type === 'supplier' ? 'אופיס דיפו' : 'ציוד משרדי'}
                className="input-base"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">
                {type === 'supplier' ? 'מספר כרטיס (קוד)' : 'קוד חשבון'}
              </label>
              <input
                value={code} onChange={(e) => setCode(e.target.value)}
                placeholder="4001"
                className="input-base font-mono"
              />
            </div>
          </div>

          {/* Supplier extra fields row */}
          {type === 'supplier' && (
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">מספר ספק</label>
                <input
                  value={supplierNumber} onChange={(e) => setSupplierNumber(e.target.value)}
                  placeholder="למשל: 12"
                  className="input-base font-mono"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">מספר תיק מע"מ</label>
                <input
                  value={vatId} onChange={(e) => setVatId(e.target.value)}
                  placeholder="511234567"
                  className="input-base font-mono"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">שם הוצאה ברירת מחדל</label>
                <select
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
            <Button onClick={handleAdd} disabled={saving || !key.trim() || !code.trim()}>
              {saving ? 'שומר...' : 'שמור'}
            </Button>
            <Button variant="secondary" onClick={() => {
              setShowForm(false);
              setKey(''); setCode(''); setSupplierNumber(''); setVatId(''); setExpenseCategory('');
            }}>ביטול</Button>
          </div>
        </div>
      )}

      {/* Tables layout: stacked vertically */}
      <div className="space-y-6">
        {/* Suppliers Table */}
        <div className="card overflow-hidden">
          <div className="px-4 py-3.5 border-b border-slate-100 bg-slate-50/50">
            <p className="font-semibold text-slate-900">ספקים</p>
            <p className="text-xs text-slate-500 mt-0.5">פרטי ספקים ומיפוי כרטיסים</p>
          </div>
          <table className="w-full text-sm text-right">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-100">
                <th className="px-4 py-2.5 text-right text-xs font-semibold text-slate-500 uppercase tracking-wide">שם ספק</th>
                <th className="px-4 py-2.5 text-right text-xs font-semibold text-slate-500 uppercase tracking-wide">מספר ספק</th>
                <th className="px-4 py-2.5 text-right text-xs font-semibold text-slate-500 uppercase tracking-wide">מספר תיק מע"מ (ח.פ.)</th>
                <th className="px-4 py-2.5 text-right text-xs font-semibold text-slate-500 uppercase tracking-wide">מספר כרטיס (קוד)</th>
                <th className="px-4 py-2.5 text-right text-xs font-semibold text-slate-500 uppercase tracking-wide">שם הוצאה ברירת מחדל</th>
                <th className="px-4 py-2.5 w-10"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {supplierMappings.map((m) => (
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
                  <td className="px-4 py-3 text-center">
                    <button
                      onClick={() => handleDelete(m.id)}
                      className="text-slate-300 hover:text-red-500 transition-colors opacity-0 group-hover:opacity-100"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              ))}
              {supplierMappings.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-slate-400">
                    אין מיפוי ספקים מוגדר
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Expense Categories Table */}
        <div className="card overflow-hidden">
          <div className="px-4 py-3.5 border-b border-slate-100 bg-slate-50/50">
            <p className="font-semibold text-slate-900">קטגוריות הוצאה</p>
            <p className="text-xs text-slate-500 mt-0.5">שם קטגוריה 🡨 קוד סעיף הוצאה</p>
          </div>
          <table className="w-full text-sm text-right">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-100">
                <th className="px-4 py-2.5 text-right text-xs font-semibold text-slate-500 uppercase tracking-wide">שם קטגוריה</th>
                <th className="px-4 py-2.5 text-right text-xs font-semibold text-slate-500 uppercase tracking-wide">קוד חשבון</th>
                <th className="px-4 py-2.5 w-10"></th>
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
                    <button
                      onClick={() => handleDelete(m.id)}
                      className="text-slate-300 hover:text-red-500 transition-colors opacity-0 group-hover:opacity-100"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
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
