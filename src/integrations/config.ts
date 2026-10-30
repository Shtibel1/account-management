import type { ConfigField } from '@/integrations/types';
import { MASK, maskSecret } from '@/lib/secrets';

/**
 * Config form helpers (pure). The browser never receives secret values, only masks, so on save:
 *   - a secret field sent as undefined, "" or a mask ("••••…") keeps the stored value;
 *   - a secret field sent as null is cleared;
 *   - non-secret fields take the sent value ("" / null clears).
 */

export type ConfigValues = Record<string, unknown>;

export function isMaskedValue(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(MASK);
}

export function mergeConfigUpdate(fields: ConfigField[], existing: ConfigValues, incoming: ConfigValues): ConfigValues {
  const out: ConfigValues = {};
  for (const field of fields) {
    const has = Object.prototype.hasOwnProperty.call(incoming, field.key);
    const value = incoming[field.key];
    if (field.secret) {
      if (has && value === null) continue;
      if (!has || value === undefined || value === '' || isMaskedValue(value)) {
        if (existing[field.key] !== undefined && existing[field.key] !== '') out[field.key] = existing[field.key];
        continue;
      }
      out[field.key] = typeof value === 'string' ? value.trim() : value;
      continue;
    }
    const v = has ? value : existing[field.key];
    if (v === null || v === undefined || v === '') continue;
    out[field.key] = typeof v === 'string' ? v.trim() : v;
  }
  return out;
}

/** Config with secret values replaced by masks (safe to store in config_masked / send to the browser). */
export function maskConfig(fields: ConfigField[], config: ConfigValues): ConfigValues {
  const out: ConfigValues = {};
  for (const field of fields) {
    const value = config[field.key];
    if (value === undefined || value === null || value === '') continue;
    out[field.key] = field.secret ? maskSecret(String(value)) : value;
  }
  return out;
}

/** Secret field names and their current values (for redaction). */
export function secretsOf(fields: ConfigField[], config: ConfigValues): { keys: string[]; values: string[] } {
  const keys = fields.filter((f) => f.secret).map((f) => f.key);
  const values = keys
    .map((k) => config[k])
    .filter((v): v is string => typeof v === 'string' && v.length > 0);
  return { keys, values };
}
