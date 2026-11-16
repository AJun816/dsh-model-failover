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
import type { Config as ConfigType, FailoverGroup } from './types.js';
/**
 * Runtime schema for the plugin config. Every field is volatile so GUI edits
 * re-wire the listeners without a restart. Undefined when the schema library is
 * unavailable — cordis then skips validation and passes the config through.
 */
export declare const Config: unknown;
/**
 * The active group: the configured activeGroup id when it matches, else the
 * first group. Undefined when no group is usable.
 */
export declare function activeGroupOf(config: ConfigType): FailoverGroup | undefined;
