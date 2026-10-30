/**
 * Feature flag registry + pure resolution rules (browser-safe; no env / DB access here).
 * Server-side lookups live in src/lib/featureFlags.ts, the browser hook in
 * src/components/FeatureFlags/useFeatureFlags.ts. See docs/feature_flags.md.
 *
 * Resolution order for a flag in an office (organization):
 *   1. the office's own row in org_feature_flags (owner toggled it in "תכונות ניסיוניות");
 *   2. otherwise the server default from env FEATURE_FLAGS_DEFAULT (comma-separated flag names);
 *   3. otherwise off.
 */

export interface FeatureFlagDefinition {
  /** Hebrew title shown in the settings page. */
  label: string;
  /** Hebrew description of what turning it on does. */
  description: string;
}

export const FEATURE_FLAGS = {
  accountant_review_loop: {
    label: 'החזרת הוצאות ללקוח',
    description:
      'בדיקה ואישור: פעולת "החזר ללקוח" עם סיבה (מסמך לא קריא, חסר מספר הקצאה, לא חשבונית מס, הוצאה פרטית, אחר). ' +
      'הלקוח מקבל הודעה במייל ו/או בוואטסאפ, החשבונית מסומנת "הוחזר ללקוח", ומסמך מתוקן שהלקוח שולח מקושר אליה אוטומטית.',
  },
} as const satisfies Record<string, FeatureFlagDefinition>;

export type FeatureFlag = keyof typeof FEATURE_FLAGS;

export const FEATURE_FLAG_NAMES = Object.keys(FEATURE_FLAGS) as FeatureFlag[];

export type FeatureFlagMap = Record<FeatureFlag, boolean>;

/** Per-flag state for the settings page. */
export interface FeatureFlagState {
  flag: FeatureFlag;
  label: string;
  description: string;
  /** Effective value for the office. */
  enabled: boolean;
  /** Value from FEATURE_FLAGS_DEFAULT (what "reset to default" gives). */
  defaultEnabled: boolean;
  /** The office's own setting, or null when it follows the default. */
  override: boolean | null;
}

/** GET /api/feature-flags */
export interface FeatureFlagsResponse {
  orgId: string | null;
  flags: FeatureFlagMap;
}

/** GET / PUT /api/org/feature-flags */
export interface OrgFeatureFlagsResponse {
  orgId: string;
  flags: FeatureFlagState[];
}

export function isFeatureFlag(value: unknown): value is FeatureFlag {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(FEATURE_FLAGS, value);
}

/** Flags turned on by default from a comma / whitespace separated list (unknown names ignored). */
export function parseDefaultFlags(raw: string | null | undefined): Set<FeatureFlag> {
  const result = new Set<FeatureFlag>();
  if (!raw) return result;
  for (const part of raw.split(/[\s,;]+/)) {
    const name = part.trim().toLowerCase();
    if (isFeatureFlag(name)) result.add(name);
  }
  return result;
}

export type FlagOverrides = Partial<Record<FeatureFlag, boolean>>;

/** Office override rows → map (unknown flag names ignored, last row wins). */
export function overridesFromRows(rows: { flag: string; enabled: boolean | null }[]): FlagOverrides {
  const overrides: FlagOverrides = {};
  for (const row of rows) {
    if (isFeatureFlag(row.flag) && typeof row.enabled === 'boolean') overrides[row.flag] = row.enabled;
  }
  return overrides;
}

/** Office override wins; otherwise the env default; otherwise off. */
export function resolveFlag(flag: FeatureFlag, defaults: Set<FeatureFlag>, overrides: FlagOverrides): boolean {
  const override = overrides[flag];
  if (typeof override === 'boolean') return override;
  return defaults.has(flag);
}

export function resolveAllFlags(defaults: Set<FeatureFlag>, overrides: FlagOverrides): FeatureFlagMap {
  const result = {} as FeatureFlagMap;
  for (const flag of FEATURE_FLAG_NAMES) result[flag] = resolveFlag(flag, defaults, overrides);
  return result;
}

export function describeFlags(defaults: Set<FeatureFlag>, overrides: FlagOverrides): FeatureFlagState[] {
  return FEATURE_FLAG_NAMES.map((flag) => ({
    flag,
    label: FEATURE_FLAGS[flag].label,
    description: FEATURE_FLAGS[flag].description,
    enabled: resolveFlag(flag, defaults, overrides),
    defaultEnabled: defaults.has(flag),
    override: typeof overrides[flag] === 'boolean' ? (overrides[flag] as boolean) : null,
  }));
}

/** All flags off (initial client state, and the safe fallback on errors). */
export function allFlagsOff(): FeatureFlagMap {
  return resolveAllFlags(new Set(), {});
}
