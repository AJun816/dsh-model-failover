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
/**
 * Create a pool. The injectable clock keeps cooldowns testable.
 */
export function createPool(options) {
    const { cooldownMs, store } = options;
    const now = options.now ?? (() => Date.now());
    const hydrated = store?.load(now()) ?? { cooling: {}, resets: {} };
    /** account -> cooling-until timestamp (ms). Absent = healthy. */
    const cooling = new Map(Object.entries(hydrated.cooling).map(([account, until]) => [account, { until }]));
    /** account -> provider-stated resume timestamp (ms). */
    const resets = new Map(Object.entries(hydrated.resets));
    /** Mirror the live state to the store; advisories never throw into routing. */
    function persist() {
        if (store === undefined)
            return;
        const at = now();
        const state = { cooling: {}, resets: {} };
        for (const [account, { until }] of cooling)
            if (until > at)
                state.cooling[account] = until;
        for (const [account, until] of resets)
            if (until > at)
                state.resets[account] = until;
        try {
            store.save(state, at);
        }
        catch { /* persistence is advisory */ }
    }
    function cool(account, ms = cooldownMs) {
        const previous = cooling.get(account);
        const until = now() + ms;
        // A longer explicit cooldown (e.g. provider Retry-After) is never shortened.
        cooling.set(account, { until: Math.max(until, previous?.until ?? 0) });
        persist();
    }
    function isCooling(account) {
        const hit = cooling.get(account);
        if (hit === undefined)
            return false;
        if (now() >= hit.until) {
            cooling.delete(account); // cooldown auto-recovery
            return false;
        }
        return true;
    }
    function recover(account) {
        cooling.delete(account);
        persist();
    }
    function revive(account) {
        const wasCooling = cooling.get(account) !== undefined;
        cooling.delete(account);
        persist();
        return wasCooling;
    }
    /** Remaining cooling ms (0 when healthy/expired) — drives whether a
     *  second-chance probe is worth a visible failure. */
    function remaining(account) {
        const hit = cooling.get(account);
        if (hit === undefined)
            return 0;
        return Math.max(0, hit.until - now());
    }
    /** Remember when the provider says the account can be used again. The
     *  provider's newest statement replaces an older one: a stale "next week"
     *  must not outlive a later "today 14:32". */
    function markReset(account, until) {
        if (account === '' || !Number.isFinite(until) || until <= now())
            return;
        resets.set(account, until);
        persist();
    }
    /** Provider-stated resume time (0 when none or already past). */
    function pendingReset(account) {
        const until = resets.get(account);
        if (until === undefined)
            return 0;
        if (now() >= until) {
            resets.delete(account);
            return 0;
        }
        return until;
    }
    function snapshot() {
        const out = {};
        for (const [account, { until }] of cooling) {
            if (now() < until)
                out[account] = { coolingUntil: until };
        }
        return out;
    }
    return { cool, isCooling, recover, revive, remaining, markReset, pendingReset, snapshot };
}
/**
 * The first entry of the chain whose provider is healthy, in chain order.
 * Entries with a provider-stated far-future resume time are skipped while a
 * clean alternative exists — but never dropped: when every healthy account is
 * marked, the first one is still returned (a quota-floor account stays usable
 * for normal requests; see CHANGELOG 0.11.4).
 */
export function firstHealthyEntry(entries, pool) {
    const healthy = entries.filter((entry) => !pool.isCooling(entry.provider));
    return healthy.find((entry) => pool.pendingReset(entry.provider) === 0) ?? healthy[0];
}
