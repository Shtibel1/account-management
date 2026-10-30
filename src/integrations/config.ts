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

function normalized(value: unknown): unknown {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value.trim() : value;
}

/**
 * Secret fields that an update would KEEP from the stored config (sent empty / masked) although an
 * endpoint field (type 'url': where the secrets are sent) changed. Such an update must be refused:
 * otherwise anyone who can edit the settings could point the stored token, which they cannot see,
 * at a server of their own. Returns the labels of those secrets (empty = OK).
 */
export function keptSecretsWithChangedEndpoint(fields: ConfigField[], existing: ConfigValues, incoming: ConfigValues): string[] {
  const endpointChanged = fields.some((f) =>
    !f.secret && f.type === 'url' &&
    Object.prototype.hasOwnProperty.call(incoming, f.key) &&
    existing[f.key] !== undefined && existing[f.key] !== '' &&
    normalized(incoming[f.key]) !== normalized(existing[f.key])
  );
  if (!endpointChanged) return [];
  return fields
    .filter((f) => {
      if (!f.secret) return false;
      if (existing[f.key] === undefined || existing[f.key] === '') return false;
      const has = Object.prototype.hasOwnProperty.call(incoming, f.key);
      const value = incoming[f.key];
      if (has && value === null) return false; // cleared
      return !has || value === undefined || value === '' || isMaskedValue(value);
    })
    .map((f) => f.label);
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
