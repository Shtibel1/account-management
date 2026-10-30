'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { createClient } from '@/utils/supabase/client';
import type { Client } from '@/shared/types';

/**
 * The client chosen via ?clientId= (falls back to the first client). Changing it updates the URL so
 * the page can be linked / reloaded. Must be rendered inside <Suspense> (useSearchParams).
 */
export function useSelectedClient() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [clients, setClients] = useState<Client[]>([]);
  const [loaded, setLoaded] = useState(false);
  const fromUrl = params.get('clientId') ?? '';

  useEffect(() => {
    const supabase = createClient();
    supabase.from('clients').select('*').order('name').then(({ data, error }) => {
      if (error) console.error('[Integrations] Failed to load clients:', error.message);
      setClients((data as Client[]) ?? []);
      setLoaded(true);
    });
  }, []);

  const clientId = fromUrl && clients.some((c) => c.id === fromUrl) ? fromUrl : clients[0]?.id ?? '';

  const setClientId = (id: string) => {
    const next = new URLSearchParams(params.toString());
    next.set('clientId', id);
    router.replace(`${pathname}?${next.toString()}`);
  };

  return { clients, loaded, clientId, setClientId, client: clients.find((c) => c.id === clientId) ?? null };
}

export function ClientSelect({
  clients,
  value,
  onChange,
}: {
  clients: Client[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <select className="input-base w-56" value={value} onChange={(e) => onChange(e.target.value)} aria-label="לקוח">
      {clients.length === 0 && <option value="">אין לקוחות</option>}
      {clients.map((c) => (
        <option key={c.id} value={c.id}>{c.name}</option>
      ))}
    </select>
  );
}
