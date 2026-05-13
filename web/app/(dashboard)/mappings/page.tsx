'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/utils/supabase/client';
import { AccountMapping, Client, MappingType } from '@invoice/shared-types';
import { Button } from '@/components/ui/Button';
import { Plus, Trash2, Info } from 'lucide-react';

export default function MappingsPage() {
  const supabase = createClient();
  const [clients, setClients] = useState<Client[]>([]);
  const [selectedClient, setSelectedClient] = useState<string>('');
  const [mappings, setMappings] = useState<AccountMapping[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [type, setType] = useState<MappingType>('supplier');
  const [key, setKey] = useState('');
  const [code, setCode] = useState('');
  const [saving, setSaving] = useState(false);

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
    setMappings((data as AccountMapping[]) ?? []);
  };

  useEffect(() => {
    if (selectedClient) loadMappings(selectedClient);
  }, [selectedClient]);

  const handleAdd = async () => {
    if (!key.trim() || !code.trim()) return;
    setSaving(true);
    await supabase.from('account_mappings').insert({
      client_id: selectedClient, mapping_type: type, key: key.trim(), account_code: code.trim(),
    });
    setKey(''); setCode(''); setShowForm(false); setSaving(false);
    loadMappings(selectedClient);
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
        <Button onClick={() => setShowForm(true)} disabled={!selectedClient}>
          <Plus className="h-4 w-4" /> הוסף מיפוי
        </Button>
      </div>

      {/* Info box */}
      <div className="flex gap-3 p-4 bg-blue-50 border border-blue-200 rounded-xl text-sm text-blue-800">
        <Info className="h-4 w-4 shrink-0 mt-0.5 text-blue-500" />
        <div className="space-y-1">
          <p><strong>ספק</strong> — קוד פנימי בתוכנת הנהלת החשבונות (לא ח.פ.). לדוגמה: אופיס דיפו → <code className="bg-blue-100 px-1.5 py-0.5 rounded text-xs font-mono">2340</code></p>
          <p><strong>קטגוריה</strong> — קוד סעיף הוצאה בתוכנה. לדוגמה: ציוד משרדי → <code className="bg-blue-100 px-1.5 py-0.5 rounded text-xs font-mono">4001</code></p>
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
              <label className="block text-sm font-medium text-slate-700 mb-1.5">קוד חשבון</label>
              <input
                value={code} onChange={(e) => setCode(e.target.value)}
                placeholder="4001"
                className="input-base font-mono"
              />
            </div>
          </div>
          <div className="flex gap-2 pt-1">
            <Button onClick={handleAdd} disabled={saving || !key.trim() || !code.trim()}>
              {saving ? 'שומר...' : 'שמור'}
            </Button>
            <Button variant="secondary" onClick={() => setShowForm(false)}>ביטול</Button>
          </div>
        </div>
      )}

      {/* Tables */}
      <div className="grid grid-cols-2 gap-6">
        <MappingTable
          title="ספקים"
          subtitle="שם ספק מהחשבונית → קוד חשבון"
          rows={supplierMappings}
          onDelete={handleDelete}
        />
        <MappingTable
          title="קטגוריות הוצאה"
          subtitle="שם קטגוריה → קוד סעיף הוצאה"
          rows={categoryMappings}
          onDelete={handleDelete}
          emptyAction={
            categoryMappings.length === 0 && selectedClient ? (
              <SeedCategoriesButton clientId={selectedClient} onDone={() => loadMappings(selectedClient)} />
            ) : null
          }
        />
      </div>
    </div>
  );
}

const DEFAULT_CATEGORIES = [
  'ציוד משרדי', 'שכ"ד', 'תקשורת', 'שיווק ופרסום',
  'נסיעות', 'אחזקה', 'שירותים מקצועיים', 'חשמל ומים', 'אחר',
];

function MappingTable({ title, subtitle, rows, onDelete, emptyAction }: {
  title: string;
  subtitle?: string;
  rows: AccountMapping[];
  onDelete: (id: string) => void;
  emptyAction?: React.ReactNode;
}) {
  return (
    <div className="card overflow-hidden">
      <div className="px-4 py-3.5 border-b border-slate-100">
        <p className="font-semibold text-slate-900">{title}</p>
        {subtitle && <p className="text-xs text-slate-500 mt-0.5">{subtitle}</p>}
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-slate-50 border-b border-slate-100">
            <th className="px-4 py-2.5 text-right text-xs font-semibold text-slate-500 uppercase tracking-wide">שם</th>
            <th className="px-4 py-2.5 text-right text-xs font-semibold text-slate-500 uppercase tracking-wide">קוד</th>
            <th className="px-4 py-2.5 w-10"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-50">
          {rows.map((m) => (
            <tr key={m.id} className="hover:bg-slate-50/60 transition-colors group">
              <td className="px-4 py-3 text-slate-700">{m.key}</td>
              <td className="px-4 py-3">
                <code className="bg-slate-100 text-slate-600 px-2 py-0.5 rounded text-xs font-mono">{m.account_code}</code>
              </td>
              <td className="px-4 py-3">
                <button
                  onClick={() => onDelete(m.id)}
                  className="text-slate-300 hover:text-red-500 transition-colors opacity-0 group-hover:opacity-100"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={3} className="px-4 py-8 text-center text-slate-400 text-sm">
                <div className="space-y-2">
                  <p>אין מיפויים עדיין</p>
                  {emptyAction}
                </div>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function SeedCategoriesButton({ clientId, onDone }: { clientId: string; onDone: () => void }) {
  const supabase = createClient();
  const [loading, setLoading] = useState(false);

  const handleSeed = async () => {
    setLoading(true);
    await supabase.from('account_mappings').insert(
      DEFAULT_CATEGORIES.map((cat) => ({
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
