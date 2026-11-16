'use client';

import { useCallback, useEffect, useState } from 'react';
import { fetchFeatureFlags } from '@/lib/api';
import { allFlagsOff, type FeatureFlag, type FeatureFlagMap } from '@/shared/featureFlags';

/**
 * Effective feature flags of an office, from GET /api/feature-flags.
 *   useFeatureFlags()                    the user's current office
 *   useFeatureFlags({ clientId })        the office of that client (e.g. on the review screen)
 *   useFeatureFlags({ orgId })           that office
 * Everything is off while loading and on errors, so flagged UI never flashes on.
 * The server enforces the flags on its own (flagged APIs answer 404); this only hides UI.
 */
export function useFeatureFlags(scope: { orgId?: string | null; clientId?: string | null } = {}) {
  const { orgId = null, clientId = null } = scope;
  const [flags, setFlags] = useState<FeatureFlagMap>(allFlagsOff);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchFeatureFlags({ orgId, clientId })
      .then((res) => { if (!cancelled) setFlags(res.flags); })
      .catch((err) => {
        console.error('[featureFlags] Failed to load feature flags:', err);
        if (!cancelled) setFlags(allFlagsOff());
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [orgId, clientId, reloadKey]);

  const isEnabled = useCallback((flag: FeatureFlag) => flags[flag] === true, [flags]);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  return { flags, loading, isEnabled, reload };
}

/** Shorthand for one flag. */
export function useFeatureFlag(flag: FeatureFlag, scope: { orgId?: string | null; clientId?: string | null } = {}): boolean {
  return useFeatureFlags(scope).isEnabled(flag);
}
