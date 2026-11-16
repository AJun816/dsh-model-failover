/**
 * Plugin configuration: runtime schema and group resolution.
 *
 * The schema library is loaded DYNAMICALLY on purpose: it is the plugin's only
 * runtime dependency, and a DSH upgrade that changes it (or an install that
 * skipped it) must not stop the plugin from loading. Without the library the
 * plugin exports no Config schema; cordis then passes the raw configuration
 * through, and every reader below is already defensive about shapes/defaults.
 *
 * @module dsh-model-failover/config
 */

import type { Config as ConfigType, FailoverGroup } from './types.js'

/** Minimal structural view of the schema builder this plugin uses. */
interface SchemaApi {
  object(definition: Record<string, unknown>): SchemaApi
  array(item: SchemaApi): SchemaApi
  string(): SchemaApi
  number(): SchemaApi
  boolean(): SchemaApi
  default(value: unknown): SchemaApi
  required(): SchemaApi
  volatile(): SchemaApi
}

/** Build the runtime schema; any incompatibility degrades to "no schema". */
function buildSchema(library: unknown): SchemaApi | undefined {
  if (library === null || typeof library !== 'object') return undefined
  const z = library as Partial<SchemaApi>
  if (typeof z.object !== 'function' || typeof z.array !== 'function'
    || typeof z.string !== 'function' || typeof z.number !== 'function'
    || typeof z.boolean !== 'function') return undefined
  try {
    return z.object({
      groups: z.array(z.object({
        id: z.string().required(),
        entries: z.array(z.object({
          provider: z.string().required(),
          model: z.string().required(),
        })).required(),
      })).default([]).volatile(),
      activeGroup: z.string().default('').volatile(),
      cooldownMinutes: z.number().default(30).volatile(),
      retryOn: z.array(z.string()).default(['quota', 'rate-limit', 'auth', 'network']).volatile(),
      autoDiscover: z.boolean().default(true).volatile(),
      // Default false since v0.9.3: the configured chain is authoritative.
      // Catalog fallback is opt-in (it once routed traffic into a channel the
      // user never configured — see CHANGELOG 0.9.2/0.9.3).
      fallbackToCatalog: z.boolean().default(false).volatile(),
      catalogExclude: z.array(z.string()).default([]).volatile(),
      probeOnDegraded: z.boolean().default(true).volatile(),
      probeTimeoutMs: z.number().default(2500).volatile(),
      backgroundProbe: z.boolean().default(true).volatile(),
      backgroundProbeMinutes: z.number().default(10).volatile(),
      lastSwitches: z.array(z.object({
        at: z.number().required(),
        from: z.string().required(),
        to: z.string().required(),
        reason: z.string().required(),
        via: z.string().required(),
      })).default([]).volatile(),
    })
  } catch {
    // A future schema library with an incompatible API: stay loadable.
    return undefined
  }
}

let schemaLibrary: unknown
try {
  const mod = await import('@deepseek-ai/schemastery') as { default?: unknown }
  schemaLibrary = mod.default ?? mod
} catch {
  schemaLibrary = undefined
}

/**
 * Runtime schema for the plugin config. Every field is volatile so GUI edits
 * re-wire the listeners without a restart. Undefined when the schema library is
 * unavailable — cordis then skips validation and passes the config through.
 */
export const Config: unknown = buildSchema(schemaLibrary)

/**
 * The active group: the configured activeGroup id when it matches, else the
 * first group. Undefined when no group is usable.
 */
export function activeGroupOf(config: ConfigType): FailoverGroup | undefined {
  if (!Array.isArray(config.groups) || config.groups.length === 0) return undefined
  const wanted = config.activeGroup || config.groups[0]?.id
  return config.groups.find((group) => group.id === wanted) ?? config.groups[0]
}
