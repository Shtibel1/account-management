import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * SERVER-ONLY. AES-256-GCM encryption of integration configs (API keys / tokens per client) at rest.
 *
 * Key: env INTEGRATIONS_ENCRYPTION_KEY = 32 random bytes, base64 (`openssl rand -base64 32`).
 * Format: "v1:<iv b64>:<auth tag b64>:<ciphertext b64>" (12-byte random IV, 16-byte tag).
 * `aad` (additional authenticated data) binds a ciphertext to its row, e.g. "<client_id>:<plugin_id>",
 * so a ciphertext copied to another client's row fails to decrypt.
 *
 * Decrypted values must never be returned to the browser or logged: use maskSecret() for display.
 */

if (typeof window !== 'undefined') {
  throw new Error('@/lib/secrets is server-only.');
}

const VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;
export const ENCRYPTION_KEY_ENV = 'INTEGRATIONS_ENCRYPTION_KEY';

export class SecretsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretsError';
  }
}

/** Parses a base64 32-byte key. Throws SecretsError (without echoing the value) when invalid. */
export function parseEncryptionKey(base64Key: string | undefined | null): Buffer {
  if (!base64Key || !base64Key.trim()) {
    throw new SecretsError(`${ENCRYPTION_KEY_ENV} is not set`);
  }
  const trimmed = base64Key.trim();
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(trimmed)) {
    throw new SecretsError(`${ENCRYPTION_KEY_ENV} must be base64`);
  }
  const key = Buffer.from(trimmed.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (key.length !== 32) {
    throw new SecretsError(`${ENCRYPTION_KEY_ENV} must decode to 32 bytes (got ${key.length})`);
  }
  return key;
}

/** The key from the environment (read on every call so a rotated env is picked up). */
export function getEncryptionKey(): Buffer {
  return parseEncryptionKey(process.env[ENCRYPTION_KEY_ENV]);
}

export function isEncryptionConfigured(): boolean {
  try {
    getEncryptionKey();
    return true;
  } catch {
    return false;
  }
}

export function encryptString(plaintext: string, aad: string, key: Buffer = getEncryptionKey()): string {
  if (key.length !== 32) throw new SecretsError('Encryption key must be 32 bytes');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(':');
}

export function decryptString(payload: string, aad: string, key: Buffer = getEncryptionKey()): string {
  if (key.length !== 32) throw new SecretsError('Encryption key must be 32 bytes');
  const parts = typeof payload === 'string' ? payload.split(':') : [];
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new SecretsError('Unsupported encrypted payload format');
  }
  const [, ivB64, tagB64, ctB64] = parts;
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const ciphertext = Buffer.from(ctB64, 'base64');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new SecretsError('Malformed encrypted payload');
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    // Wrong key, wrong AAD or tampered data. Deliberately no detail (and never the plaintext).
    throw new SecretsError('Decryption failed: wrong key or tampered data');
  }
}

export function encryptJson(value: unknown, aad: string, key?: Buffer): string {
  return encryptString(JSON.stringify(value), aad, key);
}

export function decryptJson<T = unknown>(payload: string, aad: string, key?: Buffer): T {
  const text = decryptString(payload, aad, key);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new SecretsError('Decrypted payload is not valid JSON');
  }
}

/** AAD for client_integrations.config_encrypted. */
export function integrationConfigAad(clientId: string, pluginId: string): string {
  return `client_integrations:${clientId}:${pluginId}`;
}

export const MASK = '••••';

/** Display mask for a secret: only the last 4 characters of values of 12+ chars are kept. */
export function maskSecret(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return '';
  if (value.length < 12) return MASK;
  return `${MASK}${value.slice(-4)}`;
}
