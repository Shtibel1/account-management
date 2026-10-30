'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { MeResponse } from '@/shared/authModel';
import { createClient } from '@/utils/supabase/client';
import { isSupabaseConfigured } from '@/lib/supabaseConfig';

interface SessionState {
  me: MeResponse | null;
  loading: boolean;
  /** Org new clients are created in (null in mock mode or while loading). */
  currentOrgId: string | null;
  currentOrgName: string | null;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionState>({
  me: null,
  loading: true,
  currentOrgId: null,
  currentOrgName: null,
  signOut: async () => {},
});

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/me', { cache: 'no-store' })
      .then(async (res) => {
        if (res.status === 401) {
          // Session expired while the page was open: back to login.
          window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
          return null;
        }
        if (!res.ok) throw new Error(`/api/me ${res.status}`);
        return (await res.json()) as MeResponse;
      })
      .then((data) => { if (!cancelled && data) setMe(data); })
      .catch((err) => console.error('[session] Failed to load the current user:', err))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const signOut = useCallback(async () => {
    if (isSupabaseConfigured()) {
      const { error } = await createClient().auth.signOut();
      if (error) console.error('[session] Sign-out failed:', error.message);
    }
    window.location.assign('/login');
  }, []);

  const currentOrgId = me?.currentOrgId ?? null;
  const currentOrgName = me
    ? (me.organizations.find((o) => o.id === currentOrgId) ?? me.organizations[0])?.name ?? null
    : null;

  return (
    <SessionContext.Provider value={{ me, loading, currentOrgId, currentOrgName, signOut }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession(): SessionState {
  return useContext(SessionContext);
}
