import { z } from 'zod';
import type { ExportPlugin, PluginInfo } from '@/integrations/types';
import { moveinPlugin } from '@/integrations/plugins/movein';
import { excelPlugin } from '@/integrations/plugins/excel';
import { webhookPlugin } from '@/integrations/plugins/webhook';
import { morningPlugin } from '@/integrations/plugins/morning';

/**
 * Plugin registry. To add a plugin: create src/integrations/plugins/<id>/ and append it to
 * BUILTIN_PLUGINS. createRegistry() validates every plugin at module load (fails fast in build/tests).
 */

export const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export class PluginRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginRegistryError';
  }
}

/** Throws PluginRegistryError if the plugin violates the contract. */
export function validatePlugin(plugin: ExportPlugin): void {
  const where = `plugin "${plugin?.id}"`;
  if (!plugin || typeof plugin !== 'object') throw new PluginRegistryError('plugin must be an object');
  if (!PLUGIN_ID_RE.test(plugin.id)) throw new PluginRegistryError(`${where}: invalid id`);
  if (!plugin.displayName?.trim()) throw new PluginRegistryError(`${where}: displayName is required`);
  if (plugin.kind !== 'api' && plugin.kind !== 'file') throw new PluginRegistryError(`${where}: kind must be api or file`);
  if (typeof plugin.testConnection !== 'function') throw new PluginRegistryError(`${where}: testConnection is required`);
  if (!(plugin.configSchema instanceof z.ZodType)) throw new PluginRegistryError(`${where}: configSchema must be a zod schema`);
  const caps = plugin.capabilities;
  for (const key of ['attachPdf', 'allocationNumber', 'duplicateCheck', 'sandbox'] as const) {
    if (typeof caps?.[key] !== 'boolean') throw new PluginRegistryError(`${where}: capabilities.${key} must be boolean`);
  }

  const keys = new Set<string>();
  for (const field of plugin.configFields) {
    if (!field.key || keys.has(field.key)) throw new PluginRegistryError(`${where}: duplicate or empty config key "${field.key}"`);
    keys.add(field.key);
    if (field.type === 'password' && !field.secret) {
      throw new PluginRegistryError(`${where}: password field "${field.key}" must be secret`);
    }
  }
  // Every schema key must be described (so secrets can't hide from redaction / masking).
  const schema = plugin.configSchema as z.ZodTypeAny;
  const inner = schema instanceof z.ZodEffects ? schema.innerType() : schema;
  if (inner instanceof z.ZodObject) {
    const shapeKeys = Object.keys(inner.shape as Record<string, unknown>);
    for (const k of shapeKeys) {
      if (!keys.has(k)) throw new PluginRegistryError(`${where}: config key "${k}" has no configFields entry`);
    }
    for (const k of keys) {
      if (!shapeKeys.includes(k)) throw new PluginRegistryError(`${where}: configFields key "${k}" is not in configSchema`);
    }
  }

  if (plugin.kind === 'api') {
    if (typeof plugin.exportInvoice !== 'function') throw new PluginRegistryError(`${where}: exportInvoice is required`);
    if (typeof plugin.buildPayload !== 'function') throw new PluginRegistryError(`${where}: buildPayload is required`);
    if (plugin.findExisting !== undefined && typeof plugin.findExisting !== 'function') {
      throw new PluginRegistryError(`${where}: findExisting must be a function`);
    }
  } else if (typeof plugin.buildFile !== 'function') {
    throw new PluginRegistryError(`${where}: buildFile is required`);
  }
}

export interface PluginRegistry {
  get(id: string): ExportPlugin | null;
  list(): ExportPlugin[];
  info(): PluginInfo[];
}

export function toPluginInfo(plugin: ExportPlugin): PluginInfo {
  return {
    id: plugin.id,
    displayName: plugin.displayName,
    description: plugin.description,
    kind: plugin.kind,
    capabilities: { ...plugin.capabilities },
    configFields: plugin.configFields.map((f) => ({ ...f, options: f.options?.map((o) => ({ ...o })) })),
  };
}

export function createRegistry(plugins: ExportPlugin[]): PluginRegistry {
  const byId = new Map<string, ExportPlugin>();
  for (const plugin of plugins) {
    validatePlugin(plugin);
    if (byId.has(plugin.id)) throw new PluginRegistryError(`duplicate plugin id "${plugin.id}"`);
    byId.set(plugin.id, plugin);
  }
  return {
    get: (id) => (typeof id === 'string' && byId.has(id) ? byId.get(id)! : null),
    list: () => [...byId.values()],
    info: () => [...byId.values()].map(toPluginInfo),
  };
}

export const BUILTIN_PLUGINS: ExportPlugin[] = [moveinPlugin, excelPlugin, webhookPlugin, morningPlugin];

export const registry: PluginRegistry = createRegistry(BUILTIN_PLUGINS);

export function getPlugin(id: string): ExportPlugin | null {
  return registry.get(id);
}
