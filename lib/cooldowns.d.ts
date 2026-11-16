/**
 * Durable account-health state: cool downs and provider-stated reset times.
 * The pool itself is per-process; without persistence every host restart
 * forgot that an account was capped until next week and re-tried it, so the
 * user burned one visible failure per dead account after each restart
 * (2026-11-16 incident: restart at 14:27, zai knobs re-tried in chain order).
 *
 * State lives in $DSH_HOME/model-failover/state.json next to switches.log.
 * On first use it is seeded from the switch log, which already records the
 * provider-stated resume times of earlier failures.
 *
 * @module dsh-model-failover/cooldowns
 */
import type { CooldownStore } from './types.js';
/**
 * Provider-stated reset times from the switch log: every recorded failure
 * carries the provider's resume wording, so a fresh process can start with the
 * knowledge the previous one had.
 */
export declare function seedResetsFromLog(text: string, now: number): Record<string, number>;
/**
 * Create the on-disk store. Returns undefined when Node builtins are
 * unreachable (non-Node host); callers then fall back to the process-local
 * pool, exactly as before.
 */
export declare function createCooldownStore(options?: {
    directory?: string;
}): CooldownStore | undefined;
