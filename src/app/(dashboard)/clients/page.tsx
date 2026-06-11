'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/utils/supabase/client';
import { Client } from '@/shared/types';
import Link from 'next/link';
import { Plus, Building2, ChevronLeft, Users, Loader2 } from 'lucide-react';

export default function ClientsPage() {
  const supabase = createClient();
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [vatAccount, setVatAccount] = useState('');
  const [saving, setSaving] = useState(false);

  const load = async () => {
    const { data } = await supabase.from('clients').select('*').order('created_at', { ascending: false });
    setClients(data ?? []);
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const DEFAULT_CATEGORY_MAPPINGS = [
    { key: 'ציוד משרדי', account_code: '4001' },
    { key: 'שכ"ד', account_code: '4010' },
    { key: 'תקשורת', account_code: '4020' },
    { key: 'שיווק ופרסום', account_code: '4030' },
    { key: 'נסיעות', account_code: '4040' },
    { key: 'אחזקה', account_code: '4050' },
    { key: 'שירותים מקצועיים', account_code: '4060' },
    { key: 'חשמל ומים', account_code: '4070' },
    { key: 'אחר', account_code: '4099' },
  ];

  const handleAdd = async () => {
    if (!name.trim()) return;
    setSaving(true);
    const { data: newClient } = await supabase
      .from('clients')
      .insert({ name: name.trim(), vat_account: vatAccount.trim() })
      .select('id')
      .single();
    if (newClient) {
      await supabase.from('account_mappings').insert(
        DEFAULT_CATEGORY_MAPPINGS.map((cat) => ({
          client_id: newClient.id,
          mapping_type: 'category',
          key: cat.key,
          account_code: cat.account_code,
        }))
      );
    }
    setName(''); setVatAccount(''); setShowForm(false); setSaving(false);
    load();
  };

  return (
    <div className="space-y-6 max-w-5xl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-slate-900">לקוחות המשרד</h2>
          <p className="text-sm text-slate-500 mt-1">
            {loading ? 'טוען...' : `${clients.length} לקוחות פעילים`}
          </p>
        </div>
        <button
          onClick={() => setShowForm(true)}
          className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2.5 rounded-xl text-sm font-semibold transition-colors shadow-sm"
        >
          <Plus className="h-4 w-4" /> לקוח חדש
        </button>
      </div>

      {/* Add form */}
      {showForm && (
        <div className="card p-6 space-y-4">
          <h3 className="font-semibold text-slate-900">הוספת לקוח חדש</h3>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">שם הלקוח *</label>
              <input
                value={name} onChange={(e) => setName(e.target.value)}
                placeholder='חברת ABC בע"מ'
                className="input-base"
                autoFocus
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">קוד חשבון מע"מ תשומות</label>
              <input
                value={vatAccount} onChange={(e) => setVatAccount(e.target.value)}
                placeholder="1310"
                className="input-base"
              />
            </div>
          </div>
          <div className="flex gap-2 pt-1">
            <button
              onClick={handleAdd} disabled={saving || !name.trim()}
              className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-5 py-2 rounded-xl text-sm font-semibold transition-colors"
            >
              {saving ? 'שומר...' : 'שמור לקוח'}
            </button>
            <button onClick={() => setShowForm(false)} className="px-5 py-2 rounded-xl text-sm font-medium text-slate-600 hover:bg-slate-100 transition-colors">
              ביטול
            </button>
          </div>
        </div>
      )}

      {/* Client grid */}
      {loading ? (
        <div className="card flex flex-col items-center justify-center py-24 text-center">
          <div className="relative flex items-center justify-center mb-4">
            <div className="absolute h-12 w-12 rounded-full border-4 border-blue-100 animate-pulse" />
            <Loader2 className="h-8 w-8 animate-spin text-blue-600 relative z-10" />
          </div>
          <p className="text-sm font-medium text-slate-500 animate-pulse">טוען לקוחות...</p>
        </div>
      ) : clients.length === 0 && !showForm ? (
        <div className="card flex flex-col items-center justify-center py-20 text-center">
          <div className="bg-blue-50 rounded-full p-5 mb-4">
            <Users className="h-10 w-10 text-blue-500" />
          </div>
          <h3 className="font-semibold text-slate-800 text-lg">אין לקוחות עדיין</h3>
          <p className="text-slate-500 text-sm mt-1 mb-5">הוסף את הלקוח הראשון כדי להתחיל</p>
          <button onClick={() => setShowForm(true)} className="bg-blue-600 text-white px-5 py-2.5 rounded-xl text-sm font-semibold hover:bg-blue-700 transition-colors">
            <Plus className="h-4 w-4 inline ml-1" /> הוסף לקוח
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {clients.map((c) => (
            <Link key={c.id} href={`/upload?clientId=${c.id}`}>
              <div className="card p-5 hover:shadow-card-md hover:border-blue-200 transition-all cursor-pointer group">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div className="bg-gradient-to-br from-blue-500 to-blue-700 rounded-xl p-2.5 shadow-sm">
                      <Building2 className="h-5 w-5 text-white" />
                    </div>
                    <div>
                      <p className="font-semibold text-slate-900 group-hover:text-blue-700 transition-colors">{c.name}</p>
                      <p className="text-xs text-slate-500 mt-0.5">
                        {c.vat_account ? `מע"מ: ${c.vat_account}` : 'קוד מע"מ לא הוגדר'}
                      </p>
                    </div>
                  </div>
                  <ChevronLeft className="h-4 w-4 text-slate-400 group-hover:text-blue-500 transition-colors mt-1" />
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
