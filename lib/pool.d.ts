/**
 * The cooled-account pool: which providers are temporarily out of rotation.
 * Cooldown state deliberately survives listener rewiring (volatile config
 * edits) so GUI changes never resurrect a just-failed account.
 *
 * @module dsh-model-failover/pool
 */
import type { AccountPool, FailoverEntry } from './types.js';
/**
 * Create a pool. The injectable clock keeps cooldowns testable.
 */
export declare function createPool(options: {
    cooldownMs: number;
    now?: () => number;
}): AccountPool;
/** The first entry of the chain whose provider is healthy, in chain order. */
export declare function firstHealthyEntry(entries: readonly FailoverEntry[], pool: AccountPool): FailoverEntry | undefined;
