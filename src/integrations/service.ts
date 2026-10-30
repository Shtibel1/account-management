import type { ZodError } from 'zod';
import type {
  ExportPlugin,
  IntegrationEnvironment,
  IntegrationLogSink,
  InvoiceFileReader,
  PluginContext,
} from '@/integrations/types';
import { supabaseInvoiceFileReader } from '@/integrations/files';
import { createIntegrationHttpClient, createIntegrationLogger, type FetchLike } from '@/integrations/http';
import { secretsOf, type ConfigValues } from '@/integrations/config';
import { decryptJson, encryptJson, integrationConfigAad } from '@/lib/secrets';
import { getStoredIntegration, supabaseLogSink, type StoredIntegration } from '@/integrations/store';

/** SERVER-ONLY: config decryption + plugin context construction. */

export class IntegrationConfigError extends Error {
  constructor(message: string, public readonly issues: string[] = []) {
    super(message);
    this.name = 'IntegrationConfigError';
  }
}

export function zodIssues(err: ZodError): string[] {
  return err.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message));
}

/** Decrypted (not yet schema-validated) config of a stored integration. */
export function decryptStoredConfig(row: Pick<StoredIntegration, 'client_id' | 'plugin_id' | 'config_encrypted'>): ConfigValues {
  if (!row.config_encrypted) return {};
  return decryptJson<ConfigValues>(row.config_encrypted, integrationConfigAad(row.client_id, row.plugin_id));
}

export function encryptConfig(clientId: string, pluginId: string, config: ConfigValues): string | null {
  return Object.keys(config).length === 0 ? null : encryptJson(config, integrationConfigAad(clientId, pluginId));
}

/** Validates a config against the plugin schema; throws IntegrationConfigError with Hebrew-ish issues. */
export function validateConfig(plugin: ExportPlugin, config: ConfigValues): unknown {
  const parsed = plugin.configSchema.safeParse(config);
  if (!parsed.success) throw new IntegrationConfigError('הגדרות החיבור אינן תקינות', zodIssues(parsed.error));
  return parsed.data;
}

export interface ContextOptions {
  plugin: ExportPlugin;
  clientId: string;
  orgId: string | null;
  environment: IntegrationEnvironment;
  /** Validated config. */
  config: unknown;
  /** Raw config values (to collect secret values for redaction). */
  rawConfig: ConfigValues;
  correlationId: string;
  dryRun: boolean;
  sink?: IntegrationLogSink;
  fetchImpl?: FetchLike;
  files?: InvoiceFileReader;
}

export function buildPluginContext(options: ContextOptions): PluginContext<unknown> {
  const { plugin } = options;
  const secrets = secretsOf(plugin.configFields, options.rawConfig);
  const redaction = { secretKeys: secrets.keys, secretValues: secrets.values };
  const sink = options.sink ?? supabaseLogSink();
  const common = {
    pluginId: plugin.id,
    clientId: options.clientId,
    orgId: options.orgId,
    correlationId: options.correlationId,
    redaction,
    sink,
  };
  return {
    pluginId: plugin.id,
    clientId: options.clientId,
    orgId: options.orgId,
    environment: options.environment,
    config: options.config,
    http: createIntegrationHttpClient({ ...common, fetchImpl: options.fetchImpl }),
    logger: createIntegrationLogger(common),
    correlationId: options.correlationId,
    dryRun: options.dryRun,
    files: options.files ?? (plugin.capabilities.attachPdf ? supabaseInvoiceFileReader() : undefined),
  };
}

export interface ResolvedIntegration {
  stored: StoredIntegration | null;
  environment: IntegrationEnvironment;
  rawConfig: ConfigValues;
  config: unknown;
}

/**
 * The client's stored config for a plugin, decrypted + validated. File plugins without config work
 * without a stored row; api plugins need an enabled row.
 */
export async function resolveIntegration(plugin: ExportPlugin, clientId: string): Promise<ResolvedIntegration> {
  const stored = await getStoredIntegration(clientId, plugin.id);
  if (!stored) {
    if (plugin.kind === 'file' && plugin.configFields.length === 0) {
      return { stored: null, environment: 'production', rawConfig: {}, config: validateConfig(plugin, {}) };
    }
    throw new IntegrationConfigError('החיבור לא הוגדר ללקוח זה');
  }
  if (!stored.enabled) throw new IntegrationConfigError('החיבור מושבת ללקוח זה');
  const rawConfig = decryptStoredConfig(stored);
  return { stored, environment: stored.environment, rawConfig, config: validateConfig(plugin, rawConfig) };
}
