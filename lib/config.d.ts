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
/** Minimal structural view of the schema builder this plugin uses. */
interface SchemaApi {
    object(definition: Record<string, unknown>): SchemaApi;
    array(item: SchemaApi): SchemaApi;
    string(): SchemaApi;
    number(): SchemaApi;
    boolean(): SchemaApi;
    default(value: unknown): SchemaApi;
    required(): SchemaApi;
    volatile(): SchemaApi;
}
/**
 * Build the runtime schema; any incompatibility degrades to "no schema".
 * The schema library's default export is CALLABLE (typeof 'function'), so both
 * functions and objects must be accepted — 0.17.0 accepted objects only and
 * silently produced no schema, which removed the settings namespace from the
 * GUI ("namespace not served", 2026-11-16 15:47 incident).
 */
export declare function buildSchema(library: unknown): SchemaApi | undefined;
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
export {};
