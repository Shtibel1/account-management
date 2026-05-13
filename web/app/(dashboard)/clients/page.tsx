'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/utils/supabase/client';
import { Client } from '@invoice/shared-types';
import { Button } from '@/components/ui/Button';
import Link from 'next/link';
import { Plus, Building2 } from 'lucide-react';

export default function ClientsPage() {
  const supabase = createClient();
  const [clients, setClients] = useState<Client[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [vatAccount, setVatAccount] = useState('');
  const [saving, setSaving] = useState(false);

  const load = async () => {
    const { data } = await supabase.from('clients').select('*').order('created_at', { ascending: false });
    setClients(data ?? []);
  };

  useEffect(() => { load(); }, []);

  const handleAdd = async () => {
    if (!name.trim()) return;
    setSaving(true);
    await supabase.from('clients').insert({ name: name.trim(), vat_account: vatAccount.trim() });
    setName(''); setVatAccount(''); setShowForm(false); setSaving(false);
    load();
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">לקוחות המשרד</h1>
        <Button onClick={() => setShowForm(true)} size="sm">
          <Plus className="h-4 w-4 ml-1" /> הוסף לקוח
        </Button>
      </div>

      {showForm && (
        <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
          <h2 className="font-semibold text-gray-900">לקוח חדש</h2>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">שם הלקוח</label>
              <input
                value={name} onChange={(e) => setName(e.target.value)}
                placeholder="לדוגמה: חברת ABC בע&quot;מ"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">קוד חשבון מע"מ תשומות</label>
              <input
                value={vatAccount} onChange={(e) => setVatAccount(e.target.value)}
                placeholder="לדוגמה: 1310"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
            </div>
          </div>
          <div className="flex gap-2">
            <Button onClick={handleAdd} disabled={saving || !name.trim()}>
              {saving ? 'שומר...' : 'שמור'}
            </Button>
            <Button variant="secondary" onClick={() => setShowForm(false)}>ביטול</Button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {clients.map((c) => (
          <Link key={c.id} href={`/upload?clientId=${c.id}`}>
            <div className="bg-white rounded-xl border border-gray-200 p-5 hover:border-primary-400 hover:shadow-sm transition-all cursor-pointer">
              <div className="flex items-center gap-3">
                <div className="bg-primary-100 rounded-lg p-2">
                  <Building2 className="h-5 w-5 text-primary-600" />
                </div>
                <div>
                  <p className="font-semibold text-gray-900">{c.name}</p>
                  <p className="text-xs text-gray-500">קוד מע"מ: {c.vat_account || '—'}</p>
                </div>
              </div>
            </div>
          </Link>
        ))}
        {clients.length === 0 && (
          <p className="text-gray-400 col-span-3 text-center py-8">אין לקוחות — הוסף את הראשון</p>
        )}
      </div>
    </div>
  );
}
