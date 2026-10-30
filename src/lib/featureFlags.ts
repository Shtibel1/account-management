import type { SupabaseClient } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import { deny } from '@/lib/auth';
import {
  describeFlags,
  overridesFromRows,
  parseDefaultFlags,
  resolveAllFlags,
  resolveFlag,
  type FeatureFlag,
  type FeatureFlagMap,
  type FeatureFlagState,
  type FlagOverrides,
} from '@/shared/featureFlags';
import type { NextResponse } from 'next/server';

/**
 * SERVER-SIDE feature flag lookups (service role, so callers must have checked access to the
 * office / client first - see src/lib/auth.ts). Rules in src/shared/featureFlags.ts; docs in
 * docs/feature_flags.md.
 *
 * Fails closed to the env defaults: if org_feature_flags can't be read (migration not applied,
 * mock DB) the office simply has no overrides.
 */

const TABLE = 'org_feature_flags';

interface FlagDeps {
  db: SupabaseClient;
  /** Raw FEATURE_FLAGS_DEFAULT value (read on every call so tests / env changes apply). */
  defaultsEnv: () => string | undefined;
}

const deps: FlagDeps = {
  db: supabase,
  defaultsEnv: () => process.env.FEATURE_FLAGS_DEFAULT,
};

/** Test hook: replace the DB / env source. Not used by the app. */
export function setFeatureFlagDependenciesForTests(overrides: Partial<FlagDeps>): void {
  Object.assign(deps, overrides);
}

export function defaultFlags(): Set<FeatureFlag> {
  return parseDefaultFlags(deps.defaultsEnv());
}

/** The office's own settings ({} for null org = mock mode, or when the table is unavailable). */
export async function loadOrgOverrides(orgId: string | null): Promise<FlagOverrides> {
  if (!orgId) return {};
  try {
    const { data, error } = await deps.db.from(TABLE).select('flag, enabled').eq('org_id', orgId);
    if (error) {
      console.warn(`[featureFlags] ${TABLE} unavailable (migration not applied?), using defaults:`, error.message);
      return {};
    }
    return overridesFromRows((data ?? []) as { flag: string; enabled: boolean | null }[]);
  } catch (err) {
    console.error('[featureFlags] Failed to load office overrides, using defaults:', err);
    return {};
  }
}

/** Is the flag on for this office? orgId null (mock mode) → env default only. */
export async function isEnabled(orgId: string | null, flag: FeatureFlag): Promise<boolean> {
  return resolveFlag(flag, defaultFlags(), await loadOrgOverrides(orgId));
}

export async function getOrgFlags(orgId: string | null): Promise<FeatureFlagMap> {
  return resolveAllFlags(defaultFlags(), await loadOrgOverrides(orgId));
}

export async function getOrgFlagStates(orgId: string): Promise<FeatureFlagState[]> {
  return describeFlags(defaultFlags(), await loadOrgOverrides(orgId));
}

/** Office of a client (null when unknown / mock DB without org_id). */
export async function orgIdOfClient(clientId: string): Promise<string | null> {
  // limit(1) instead of maybeSingle(): the local mock DB client doesn't implement maybeSingle.
  const { data, error } = await deps.db.from('clients').select('org_id').eq('id', clientId).limit(1);
  if (error) {
    console.error(`[featureFlags] Client ${clientId} org lookup failed:`, error.message);
    return null;
  }
  const row = (Array.isArray(data) ? data[0] : null) as { org_id?: string | null } | null | undefined;
  return row?.org_id ?? null;
}

/** For server code that only knows the client (pipeline, webhooks). */
export async function isEnabledForClient(clientId: string, flag: FeatureFlag): Promise<boolean> {
  return isEnabled(await orgIdOfClient(clientId), flag);
}

/**
 * Sets (enabled = true/false) or clears (enabled = null → back to the env default) the office's
 * own value. Caller must be an owner of the office (requireOrgOwner).
 */
export async function setOrgFlag(orgId: string, flag: FeatureFlag, enabled: boolean | null, userId: string | null): Promise<void> {
  if (enabled === null) {
    const { error } = await deps.db.from(TABLE).delete().eq('org_id', orgId).eq('flag', flag);
    if (error) throw new Error(`Failed to reset feature flag ${flag}: ${error.message}`);
    return;
  }
  const { error } = await deps.db
    .from(TABLE)
    .upsert(
      { org_id: orgId, flag, enabled, updated_at: new Date().toISOString(), updated_by: userId },
      { onConflict: 'org_id,flag' }
    );
  if (error) throw new Error(`Failed to save feature flag ${flag}: ${error.message}`);
}

/**
 * Route gate: a flagged API answers 404 (as if it didn't exist) while the flag is off for the
 * office. Returns null when the feature is on.
 */
export async function requireFeature(orgId: string | null, flag: FeatureFlag): Promise<NextResponse | null> {
  if (await isEnabled(orgId, flag)) return null;
  return deny(404, 'לא נמצא').response;
}
