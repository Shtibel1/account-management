'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/utils/supabase/client';
import { AccountMapping, Client, MappingType } from '@invoice/shared-types';
import { Button } from '@/components/ui/Button';
import { Plus, Trash2 } from 'lucide-react';

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

  useEffect(() => {
    if (!selectedClient) return;
    supabase
      .from('account_mappings')
      .select('*')
      .eq('client_id', selectedClient)
      .order('mapping_type')
      .order('key')
      .then(({ data }) => setMappings((data as AccountMapping[]) ?? []));
  }, [selectedClient]);

  const handleAdd = async () => {
    if (!key.trim() || !code.trim()) return;
    setSaving(true);
    await supabase.from('account_mappings').insert({
      client_id: selectedClient, mapping_type: type, key: key.trim(), account_code: code.trim(),
    });
    setKey(''); setCode(''); setShowForm(false); setSaving(false);
    const { data } = await supabase.from('account_mappings').select('*').eq('client_id', selectedClient).order('mapping_type').order('key');
    setMappings((data as AccountMapping[]) ?? []);
  };

  const handleDelete = async (id: string) => {
    await supabase.from('account_mappings').delete().eq('id', id);
    setMappings((prev) => prev.filter((m) => m.id !== id));
  };

  const supplierMappings = mappings.filter((m) => m.mapping_type === 'supplier');
  const categoryMappings = mappings.filter((m) => m.mapping_type === 'category');

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">מיפוי חשבונות</h1>
        <Button onClick={() => setShowForm(true)} size="sm" disabled={!selectedClient}>
          <Plus className="h-4 w-4 ml-1" /> הוסף מיפוי
        </Button>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">לקוח</label>
        <select
          value={selectedClient}
          onChange={(e) => setSelectedClient(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 min-w-[240px]"
        >
          {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>

      {showForm && (
        <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
          <h2 className="font-semibold text-gray-900">מיפוי חדש</h2>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">סוג</label>
              <select value={type} onChange={(e) => setType(e.target.value as MappingType)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500">
                <option value="supplier">ספק</option>
                <option value="category">קטגוריה</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {type === 'supplier' ? 'שם ספק' : 'שם קטגוריה'}
              </label>
              <input value={key} onChange={(e) => setKey(e.target.value)}
                placeholder={type === 'supplier' ? 'אופיס דיפו' : 'ציוד משרדי'}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">קוד חשבון</label>
              <input value={code} onChange={(e) => setCode(e.target.value)}
                placeholder="4001"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
            </div>
          </div>
          <div className="flex gap-2">
            <Button onClick={handleAdd} disabled={saving || !key.trim() || !code.trim()}>
              {saving ? 'שומר...' : 'שמור'}
            </Button>
            <Button variant="secondary" onClick={() => setShowForm(false)}>ביטול</Button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-6">
        <MappingTable title="ספקים" rows={supplierMappings} onDelete={handleDelete} />
        <MappingTable title="קטגוריות" rows={categoryMappings} onDelete={handleDelete} />
      </div>
    </div>
  );
}

function MappingTable({ title, rows, onDelete }: { title: string; rows: AccountMapping[]; onDelete: (id: string) => void }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="p-4 border-b border-gray-200 font-semibold text-gray-900">{title}</div>
      <table className="w-full text-sm">
        <thead className="bg-gray-50">
          <tr>
            <th className="p-3 text-right font-medium text-gray-600">שם</th>
            <th className="p-3 text-right font-medium text-gray-600">קוד חשבון</th>
            <th className="p-3 w-10"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map((m) => (
            <tr key={m.id} className="hover:bg-gray-50">
              <td className="p-3 text-gray-700">{m.key}</td>
              <td className="p-3"><code className="bg-gray-100 px-2 py-0.5 rounded text-xs">{m.account_code}</code></td>
              <td className="p-3">
                <button onClick={() => onDelete(m.id)} className="text-red-400 hover:text-red-600 transition-colors">
                  <Trash2 className="h-4 w-4" />
                </button>
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr><td colSpan={3} className="p-6 text-center text-gray-400">אין מיפויים</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
