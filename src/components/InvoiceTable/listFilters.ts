'use client';

import { useEffect, useState } from 'react';

// The review list's client / status filter survives leaving the list (opening an invoice, splitting
// it, approving it) and coming back (QA: after a split the list reset to "כל הלקוחות"). The URL
// (?client=&status=) wins, so a link can carry the filter; otherwise the tab's last choice is used.

const STORAGE_KEY = 'review-list-filters';

export interface ListFilters {
  client: string;
  status: string;
}

const DEFAULTS: ListFilters = { client: 'all', status: 'all' };

/** The filter to open the list with: URL params first, then the stored filter of this tab. */
export function initialListFilters(search: string, stored: string | null): ListFilters {
  const params = new URLSearchParams(search);
  let saved: Partial<ListFilters> = {};
  try {
    const parsed = stored ? JSON.parse(stored) : null;
    if (parsed && typeof parsed === 'object') saved = parsed as Partial<ListFilters>;
  } catch {
    saved = {};
  }
  const pick = (key: keyof ListFilters) => {
    const fromUrl = params.get(key);
    if (fromUrl) return fromUrl;
    const v = saved[key];
    return typeof v === 'string' && v ? v : DEFAULTS[key];
  };
  return { client: pick('client'), status: pick('status') };
}

/** The review list URL that opens with this client selected. */
export function reviewListHref(clientId: string | null | undefined): string {
  return clientId ? `/review?client=${encodeURIComponent(clientId)}` : '/review';
}

function readStored(): string | null {
  try {
    return window.sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Client / status filter state of the review list, restored on mount and remembered per tab. */
export function useListFilters() {
  const [filters, setFilters] = useState<ListFilters>(DEFAULTS);
  const [restored, setRestored] = useState(false);

  useEffect(() => {
    setFilters(initialListFilters(window.location.search, readStored()));
    setRestored(true);
  }, []);

  useEffect(() => {
    if (!restored) return;
    try {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(filters));
    } catch {
      // storage blocked: the filter just isn't remembered
    }
    // Keep the URL in step (no navigation), so reload / back shows the same filter
    try {
      const url = new URL(window.location.href);
      for (const key of ['client', 'status'] as const) {
        if (filters[key] === 'all') url.searchParams.delete(key);
        else url.searchParams.set(key, filters[key]);
      }
      window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
    } catch {
      // ignore
    }
  }, [filters, restored]);

  return {
    clientFilter: filters.client,
    statusFilter: filters.status,
    setClientFilter: (client: string) => setFilters((f) => ({ ...f, client })),
    setStatusFilter: (status: string) => setFilters((f) => ({ ...f, status })),
  };
}
