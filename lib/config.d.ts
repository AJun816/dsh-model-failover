/**
 * Plugin configuration: runtime schema and group resolution.
 *
 * @module dsh-model-failover/config
 */
import z from '@deepseek-ai/schemastery';
import type { Config as ConfigType, FailoverGroup } from './types.js';
/**
 * Runtime schema for {@link Config}. Every field is volatile so GUI edits
 * re-wire the listeners without a restart.
 */
export declare const Config: z<ConfigType>;
/**
 * The active group: the configured activeGroup id when it matches, else the
 * first group. Undefined when no group is usable.
 */
export declare function activeGroupOf(config: ConfigType): FailoverGroup | undefined;
