/**
 * The cooled-account pool: which providers are temporarily out of rotation,
 * plus the provider-stated resume times that outlive a process. Cooldown state
 * deliberately survives listener rewiring (volatile config edits) so GUI
 * changes never resurrect a just-failed account; with a {@link CooldownStore}
 * it also survives host restarts (2026-11-16: a restart forgot every capped
 * account and burned one visible failure per dead account).
 *
 * @module dsh-model-failover/pool
 */
import type { AccountPool, CooldownStore, FailoverEntry } from './types.js';
/**
 * Create a pool. The injectable clock keeps cooldowns testable.
 */
export declare function createPool(options: {
    cooldownMs: number;
    now?: () => number;
    store?: CooldownStore;
}): AccountPool;
/**
 * The first entry of the chain whose provider is healthy, in chain order.
 * Entries with a provider-stated far-future resume time are skipped while a
 * clean alternative exists — but never dropped: when every healthy account is
 * marked, the first one is still returned (a quota-floor account stays usable
 * for normal requests; see CHANGELOG 0.11.4).
 */
export declare function firstHealthyEntry(entries: readonly FailoverEntry[], pool: AccountPool): FailoverEntry | undefined;
