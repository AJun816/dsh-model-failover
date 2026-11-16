/**
 * dsh-model-failover — automatic model & account failover for DeepSeek Harness.
 *
 * Listens to the two public agent-loop waterfalls:
 *  - `agent/request` (prepended): routes every model call to the first
 *    healthy entry of the active fallback group (array order = failover
 *    order). The configured chain is authoritative since v0.9.3; catalog
 *    fallback beyond it is opt-in via `fallbackToCatalog`.
 *  - `agent/request-error` (prepended, so it always runs): classifies the
 *    failure, cools the account down, then always delegates to downstream
 *    listeners (e.g. the built-in llm-retry keeps its backoff); only when
 *    downstream has no recovery of its own and a healthy alternative exists
 *    does it answer { kind: 'retry' } so the loop re-runs agent/request on
 *    the next account.
 *
 * Near-zero dependencies (only the official @deepseek-ai/schemastery schema
 * lib). Every listener is wrapped defensively: if anything inside throws, it
 * falls through to next() and DSH behaves exactly as if the plugin were not
 * installed.
 *
 * Module map: types.ts (contracts) · coerce.ts (config reads) ·
 * classifier.ts (failure classes) · pool.ts (cooldowns) ·
 * records.ts (switch fan-out) · config.ts (schema + groups) · this file
 * (waterfall wiring).
 *
 * @module dsh-model-failover
 */
import { classifyFailure, providerExcluded, retryAfterFromMessage } from './classifier.js';
import { createPool, firstHealthyEntry } from './pool.js';
import { createCooldownStore } from './cooldowns.js';
import { createProber } from './probe.js';
import { recordArmed, recordSwitch, writeLoadMarker } from './records.js';
import { activeGroupOf, Config as ConfigBinding } from './config.js';
import { VERSION } from './version.js';
import { boolOf, finiteOr, stringListOf, unwrapVolatile, valueOf } from './coerce.js';
export const name = 'model-failover';
export const inject = ['llm'];
// External load proof: one line per process that evaluated this module.
// If the host loads this plugin, ~/.dsh/model-failover/load.log shows it even
// when apply() later fails or the host stdout is unreachable.
void writeLoadMarker(VERSION);
// ---- Public surface (kept stable for the loader, GUI card and tests) ----
export { classifyFailure, providerExcluded, retryAfterFromMessage } from './classifier.js';
export { writeLoadMarker } from './records.js';
export { createPool, firstHealthyEntry } from './pool.js';
export { createCooldownStore, seedResetsFromLog } from './cooldowns.js';
export { activeGroupOf };
export { ConfigBinding as Config };
export { VERSION };
/** Neutral LlmCallConfig fields safe to keep when the provider changes. */
const NEUTRAL_FIELDS = ['maxTokens', 'temperature'];
/** Minimum spacing between second-chance probes of one provider. */
const REVIVE_INTERVAL_MS = 5 * 60_000;
/** A second-chance probe is worth one visible failure only when the cooldown
 *  ends soon (window reset / likely recharge). Far-future caps (GLM 1310
 *  weekly, reset days away) must NOT be probed — every probe is a guaranteed
 *  user-visible failure (2026-11-14 16:38 incident). */
const REVIVABLE_WINDOW_MS = 15 * 60_000;
/** Pause before an instant failover hop; providers burst-limit rapid switches. */
const HOP_DELAY_MS = 400;
/** Probe spacing ceiling: each failed second-chance probe of one provider
 *  multiplies its next probe spacing by 4 (5min → 20min → 1h20m → 5h20m),
 *  capped here. Without this, a fully-exhausted pool with a short configured
 *  cooldown probes dead accounts forever (the 2026-11-15 "endless switch
 *  failures" incident: 36 visible failures in 90 minutes with two dead
 *  accounts alternating every REVIVE_INTERVAL). */
const PROBE_BACKOFF_CEILING_MS = 6 * 60 * 60_000;
/** A failure within this window after a revive counts as a failed probe. */
const PROBE_ATTRIB_WINDOW_MS = 10 * 60_000;
/** Hard caps so the per-agent bookkeeping maps can never grow unbounded. */
const IN_FLIGHT_CAP = 64;
const BUDGET_CAP = 1_000;
/** Catalog-fallback hops per turn/step: a small budget of their own. */
const FALLBACK_HOPS_PER_STEP = 2;
/** How long a successful probe keeps a provider verified (skip re-probing). */
const PROBE_CACHE_MS = 5 * 60_000;
/** Total budget for walking the chain with probes; past it, trust chain order. */
const VERIFY_BUDGET_MS = 6_000;
/** How often the supervisor re-checks live agents while the pool is degraded. */
const SUPERVISION_INTERVAL_MS = 60_000;
/** Delay before the first supervision pass, letting the host populate agents. */
const SUPERVISION_START_DELAY_MS = 1_500;
/** Delay before re-supervising after a failure (the agent may be mid-turn). */
const SUPERVISION_FAILURE_DELAY_MS = 500;
/**
 * The provider/model the agent loop actually fixed for this request: the
 * resolved call config when usable, else the step's model selection. On the
 * DSH >= 0.2.2 fixed-route architecture this is the ONLY correct identity for
 * failover bookkeeping — recording the chain head instead cools a healthy
 * account and leaves the quota-exhausted one selected forever (2026-11-16
 * incident: default model deepseek-account ran out of quota, the plugin cooled
 * zai-coding-cn and "switched" to a zai account that was already capped).
 */
function routeOf(resolved, payload) {
    const cfg = resolved;
    if (cfg !== null && typeof cfg === 'object'
        && typeof cfg.provider === 'string' && cfg.provider !== ''
        && typeof cfg.model === 'string' && cfg.model !== '') {
        return { provider: cfg.provider, model: cfg.model };
    }
    const selection = payload?.modelSelection ?? payload?.agent?.model?.current?.();
    if (selection !== undefined
        && typeof selection.provider === 'string' && selection.provider !== ''
        && typeof selection.model === 'string' && selection.model !== '') {
        return { provider: selection.provider, model: selection.model };
    }
    return undefined;
}
/** Re-target a resolved call config onto the selected entry. */
function reroute(resolved, selected) {
    const out = selected.provider === resolved.provider ? { ...resolved } : {};
    for (const field of NEUTRAL_FIELDS) {
        if (resolved[field] !== undefined)
            out[field] = resolved[field];
    }
    out.provider = selected.provider;
    out.model = selected.model;
    return out;
}
/** Stable per-agent identity: session id preferred, agent id as fallback. */
function agentKeyOf(payload) {
    const agent = payload?.agent;
    const raw = agent?.session?.id ?? agent?.id;
    return raw === undefined || raw === null ? undefined : String(raw);
}
/** Bounded retry-budget bookkeeping, keyed by agent|turn|step. */
function createBudgets() {
    const chain = new Map();
    const fallback = new Map();
    /** Spend one unit; unkeyed steps cannot accumulate and always report 1. */
    const spend = (map, key) => {
        if (key === undefined)
            return 1;
        const used = (map.get(key) ?? 0) + 1;
        map.set(key, used);
        if (map.size > BUDGET_CAP)
            map.clear();
        return used;
    };
    return {
        spendChainHop: (key) => spend(chain, key),
        spendFallbackHop: (key) => spend(fallback, key),
    };
}
/** Which entry the in-flight request uses, per agent key (bounded). */
function createFlightTracker() {
    const inFlight = new Map();
    return {
        set(key, entry) {
            if (inFlight.size > IN_FLIGHT_CAP)
                inFlight.clear();
            inFlight.set(key, entry);
        },
        get: (key) => (key === undefined ? undefined : inFlight.get(key)),
        clear(key) {
            if (key !== undefined)
                inFlight.delete(key);
        },
    };
}
/**
 * Auto-discovered chain: one entry per configured provider (its first model),
 * in registry order, minus catalogExclude entries. Refreshed on adapter
 * topology changes; empty while the registry is unavailable.
 */
function startAutoDiscovery(ctx, config) {
    let entries = [];
    const llm = ctx.llm;
    const refresh = async () => {
        if (llm === undefined)
            return;
        const excluded = stringListOf(unwrapVolatile(config.catalogExclude));
        try {
            const found = [];
            for (const provider of llm.listProviders()) {
                if (providerExcluded(excluded, provider.id))
                    continue;
                try {
                    const models = await llm.listModels(provider.id);
                    const first = models[0];
                    if (first !== undefined)
                        found.push({ provider: provider.id, model: first.id });
                }
                catch { /* a provider whose catalog fails is skipped this round */ }
            }
            entries = found;
        }
        catch (error) {
            ctx.logger?.warn?.('model-failover: auto-discovery failed: %o', error);
        }
    };
    void refresh();
    const off = ctx.on('llm/adapters-updated', (() => { void refresh(); }));
    return { snapshot: () => entries, dispose: off };
}
/**
 * Install the failover listeners.
 * @param ctx plugin context
 * @param config resolved plugin configuration
 * @param internals test hooks
 */
export function apply(ctx, config = {}, internals = {}) {
    try {
        return runApply(ctx, config, internals);
    }
    catch (error) {
        // Load-level failures must leave an external trace: a plugin that fails
        // before wiring otherwise vanishes into host stdout (2026-11-01 case:
        // module evaluated, apply threw, plugin inert, no visible reason).
        void writeLoadMarker(VERSION, 'apply failed: ' + String(error?.message ?? error));
        throw error;
    }
}
/** Resolve after ms; a rejected-interruption is impossible with a plain handler. */
function sleep(ms) {
    return new Promise((resolve) => { setTimeout(resolve, ms); });
}
/** Compact provider-side failure fingerprint for the switch log: code + first words of the message. */
function failureDetail(failure) {
    const code = String(failure?.code ?? '?');
    const message = String(failure?.message ?? '').replace(/\s+/g, ' ').slice(0, 80);
    const status = failure?.status !== undefined ? String(failure.status) : '';
    return [code, status, message].filter(Boolean).join(' ');
}
function runApply(ctx, config = {}, internals = {}) {
    const now = internals.now ?? (() => Date.now());
    const pool = internals.pool ?? createPool({ cooldownMs: 30 * 60_000, now, store: createCooldownStore() });
    /** Record a switch through all channels without blocking the retry decision. */
    const note = (payload, from, to, reason, via) => {
        // Recording is advisory: swallow even programming errors so no switch can
        // ever surface as an unhandled rejection inside the host process.
        recordSwitch(ctx, payload, { at: now(), from, to, reason, via }, internals.logFile)
            .catch(() => { });
    };
    const flights = createFlightTracker();
    const budgets = createBudgets();
    /** Last second-chance revive per provider, throttling probes on fully-cooled pools. */
    const lastRevive = new Map();
    /** Last failure per provider — a provider that JUST failed is never probed. */
    const lastFailAt = new Map();
    /** Consecutive failed probes per provider — drives exponential probe backoff. */
    const reviveFails = new Map();
    /** Current second-chance probe spacing for one provider (grows per failed probe). */
    const probeGapMs = (provider) => {
        const fails = reviveFails.get(provider) ?? 0;
        return Math.min(REVIVE_INTERVAL_MS * 4 ** fails, PROBE_BACKOFF_CEILING_MS);
    };
    /** Register a failure of one provider: attribute it to a recent probe (steepening
     *  that provider's backoff) or to a healthy stretch (resetting it). */
    const noteFailure = (provider) => {
        lastFailAt.set(provider, now());
        const revivedAt = lastRevive.get(provider);
        if (revivedAt !== undefined && now() - revivedAt < PROBE_ATTRIB_WINDOW_MS) {
            reviveFails.set(provider, (reviveFails.get(provider) ?? 0) + 1);
        }
        else {
            reviveFails.delete(provider); // it had served since the last probe: fresh slate
        }
    };
    /** Eligibility shared by both second-chance sites: soon-expiring cooldown,
     *  honored probe spacing, and no failure in the last probe interval. */
    const probeEligible = (entry) => {
        if (pool.remaining(entry.provider) > REVIVABLE_WINDOW_MS)
            return false; // far-future cap: probing is guaranteed failure
        if (now() - (lastRevive.get(entry.provider) ?? Number.NEGATIVE_INFINITY) < probeGapMs(entry.provider))
            return false;
        if (now() - (lastFailAt.get(entry.provider) ?? Number.NEGATIVE_INFINITY) < REVIVE_INTERVAL_MS)
            return false;
        return true;
    };
    /** Consecutive GLM 1310 repeats within 24h per provider — drives exponential backoff. */
    const weeklyCapRepeats = new Map();
    /** Timestamp of the last 1310 per provider. */
    const lastWeeklyCap = new Map();
    const auto = startAutoDiscovery(ctx, config);
    /**
     * Wire the listeners from the current (volatile) config. Re-run by cordis
     * whenever a volatile field changes, so GUI edits apply without a restart;
     * the pool's cooling state deliberately survives re-wiring.
     */
    const wire = () => {
        // Every read unwraps cosmokit volatile descriptors: after the settings
        // layer takes the namespace over, plain reads return { get, write }
        // wrappers and every array/typeof check would silently fail.
        const cooldownMs = finiteOr(unwrapVolatile(config.cooldownMinutes), 30) * 60_000;
        const retryList = stringListOf(unwrapVolatile(config.retryOn));
        const retryOn = new Set(retryList.length > 0 ? retryList : ['quota', 'rate-limit', 'auth', 'network']);
        const autoOn = boolOf(unwrapVolatile(config.autoDiscover), true);
        const fallbackOn = boolOf(unwrapVolatile(config.fallbackToCatalog), false);
        const excluded = stringListOf(unwrapVolatile(config.catalogExclude));
        const groupsRaw = valueOf(unwrapVolatile(config.groups));
        const groupsValue = Array.isArray(groupsRaw) ? groupsRaw : [];
        const wantedGroupId = String(unwrapVolatile(config.activeGroup) ?? '').trim();
        if (wantedGroupId !== '' && !groupsValue.some((g) => g.id === wantedGroupId)) {
            // Config drift: the GUI group list was edited but activeGroup still names a
            // removed id (2026-11-15: activeGroup "glm-pool" vs the surviving "main").
            // activeGroupOf silently falls back to the first group — surface it.
            ctx.logger?.warn?.('model-failover: activeGroup "%s" matches no configured group (%s) — falling back to "%s"; fix the plugin config to stop the drift', wantedGroupId, groupsValue.map((g) => g.id).join(', ') || 'none', groupsValue[0]?.id ?? '-');
        }
        let group = activeGroupOf({ groups: groupsValue, activeGroup: unwrapVolatile(config.activeGroup) });
        if (groupsValue.length === 0 && autoOn) {
            group = { id: 'auto', entries: auto.snapshot() };
        }
        if (group === undefined || group.entries.length === 0) {
            ctx.logger?.info?.('model-failover: no groups or entries configured — plugin stays inactive (pass-through)');
            void recordArmed(ctx, { at: now(), version: VERSION, group: '-', entries: 0, mode: 'inactive', note: 'no groups or entries configured' });
            return () => { };
        }
        ctx.logger?.info?.(`model-failover: v${VERSION} active group "${group.id}" with ${group.entries.length} entries (${group.entries.map((e) => e.provider + '/' + e.model).join(' → ')})`);
        void recordArmed(ctx, { at: now(), version: VERSION, group: group.id, entries: group.entries.length, mode: 'active' });
        /** First healthy entry outside the active group (opt-in catalog fallback). */
        const fallbackEntry = () => {
            if (!fallbackOn || group === undefined)
                return undefined;
            const inGroup = new Set(group.entries.map((entry) => entry.provider));
            return auto.snapshot().find((entry) => !inGroup.has(entry.provider) && !pool.isCooling(entry.provider) && !providerExcluded(excluded, entry.provider));
        };
        // ---- Preflight verification -------------------------------------------
        // Dead accounts used to be discovered one failed turn at a time. While the
        // pool is degraded we instead verify candidates with a one-token probe and
        // skip the dead ones, so a switch lands on an account that actually works.
        const probeOnDegraded = boolOf(unwrapVolatile(config.probeOnDegraded), true);
        const probeTimeoutMs = finiteOr(unwrapVolatile(config.probeTimeoutMs), 2500);
        const prober = createProber(ctx.llm, {
            now, timeoutMs: probeTimeoutMs, cacheMs: PROBE_CACHE_MS,
        });
        /** True while any account is out of rotation or carries a provider reset. */
        const degraded = () => Object.keys(pool.snapshot()).length > 0
            || group.entries.some((entry) => pool.pendingReset(entry.provider) > now());
        // ---- Background supervision -------------------------------------------
        // The host fixes a step's route before agent/pre-step runs (installed
        // agent-loop throws if agent/request proposes another route), so a stale
        // selection can only be repaired BEFORE the next message. While the pool is
        // degraded, re-route live agents whose selection is cooling/marked so the
        // next turn assembles on a healthy account (2026-11-16 14:48: restart with
        // a dead selection cost one failed message; supervision prevents exactly
        // that).
        const agentsService = ctx.agents
            ?? (typeof ctx.get === 'function' ? ctx.get('agents') : undefined);
        let supervisionTimer;
        let supervisionDisposed = false;
        let supervising = false;
        /** Take one provider out of rotation after a real (or probe) failure. */
        const penalize = (provider, failure) => {
            const message = String(failure?.message ?? '');
            const stated = Math.max(finiteOr(failure?.providerRetryAfterMs, 0), retryAfterFromMessage(message, now()));
            if (stated > 0)
                pool.markReset(provider, now() + stated);
            noteFailure(provider);
            pool.cool(provider, Math.max(cooldownMs, stated));
            prober.forget(provider);
        };
        /** Re-route every live idle agent whose current selection is out of rotation. */
        const supervise = async () => {
            if (supervising || supervisionDisposed)
                return;
            if (!probeOnDegraded || !degraded())
                return;
            const list = agentsService?.list?.() ?? [];
            supervising = true;
            try {
                for (const agent of list) {
                    try {
                        const model = agent.model;
                        if (model === undefined || typeof model.select !== 'function')
                            continue;
                        const current = model.current();
                        if (current === undefined)
                            continue;
                        if (!group.entries.some((entry) => entry.provider === current.provider))
                            continue;
                        const unavailable = pool.isCooling(current.provider) || pool.pendingReset(current.provider) > now();
                        // Unknown health is worth one probe while the pool is degraded: a
                        // fresh process has no verdict for the current selection yet.
                        if (!unavailable && prober.recentOk(current.provider))
                            continue;
                        // Verify the CURRENT selection first; only a failing verdict moves
                        // the agent down the chain (never reorder a healthy choice).
                        const preferred = unavailable
                            ? (firstHealthyEntry(group.entries, pool) ?? fallbackEntry())
                            : { provider: current.provider, model: current.model };
                        const verified = await chooseVerified(undefined, preferred);
                        if (verified === undefined)
                            continue;
                        if (verified.provider === current.provider && verified.model === current.model)
                            continue;
                        model.select({ provider: verified.provider, model: verified.model });
                        note({ agent }, current.provider, verified.provider, 'supervision: selection was out of rotation', 'probe');
                        ctx.logger?.info?.('model-failover: supervision moved %s/%s → %s/%s before the next message', current.provider, current.model, verified.provider, verified.model);
                    }
                    catch (error) {
                        ctx.logger?.warn?.('model-failover: supervision of one agent failed: %o', error);
                    }
                }
            }
            finally {
                supervising = false;
            }
        };
        /** Supervision is only possible when the host exposes the agents service. */
        const supervisionAvailable = typeof agentsService?.list === 'function';
        /** Run supervision soon; keep a slow, non-blocking loop alive while degraded. */
        const scheduleSupervision = (delayMs, force = false) => {
            if (supervisionDisposed || !supervisionAvailable)
                return;
            if (supervisionTimer !== undefined) {
                if (!force)
                    return;
                clearTimeout(supervisionTimer);
                supervisionTimer = undefined;
            }
            const handle = setTimeout(() => {
                supervisionTimer = undefined;
                void supervise().catch(() => { });
                if (!supervisionDisposed && degraded())
                    scheduleSupervision(SUPERVISION_INTERVAL_MS);
            }, delayMs);
            // Never hold the host process (or a test runner) open for a background check.
            handle.unref?.();
            supervisionTimer = handle;
        };
        /**
         * Walk the chain (preferred pick first) and return the first account that
         * answers a cheap probe. Dead candidates are cooled on the way, so the
         * decision is durable for the next step/turn. Returns the preferred/chain
         * pick untouched when probing is off, unavailable, or the pool is healthy.
         */
        const chooseVerified = async (failedProvider, preferred) => {
            const base = preferred ?? firstHealthyEntry(group.entries, pool) ?? fallbackEntry();
            if (!probeOnDegraded || !prober.capable || !degraded())
                return base;
            const deadline = now() + VERIFY_BUDGET_MS;
            const candidates = [];
            if (base !== undefined)
                candidates.push(base);
            for (const entry of group.entries)
                candidates.push(entry);
            const seen = new Set();
            for (const entry of candidates) {
                if (seen.has(entry.provider))
                    continue;
                seen.add(entry.provider);
                if (entry.provider === failedProvider)
                    continue;
                if (pool.isCooling(entry.provider))
                    continue;
                if (pool.pendingReset(entry.provider) > now())
                    continue;
                if (prober.recentOk(entry.provider))
                    return entry;
                if (now() > deadline)
                    return entry; // budget spent: trust chain order
                const result = await prober.probe(entry);
                if (result.ok)
                    return entry;
                const klass = classifyFailure(result.failure);
                penalize(entry.provider, result.failure);
                ctx.logger?.info?.('model-failover: preflight probe failed for %s/%s (%s) — skipping it', entry.provider, entry.model, klass);
            }
            return undefined;
        };
        const offRequest = ctx.on('agent/request', async (payload, next) => {
            // Downstream (inner-listener) errors propagate unchanged: they are not
            // ours to swallow. Only OUR routing below degrades to pass-through.
            const resolved = await next();
            try {
                // DSH >= 0.2.2 fixes the route during step preparation and throws when
                // agent/request proposes a different one. On that architecture the
                // chain routing lives in agent/pre-step + agent.model.select(), and
                // this listener must confirm the fixed selection unchanged.
                if (payload?.agent !== undefined && typeof payload.agent.model?.select === 'function') {
                    // Track the route the loop ACTUALLY uses (never the chain head): the
                    // route fixed for this step is what a failure belongs to.
                    const key = agentKeyOf(payload);
                    const route = routeOf(resolved, payload);
                    if (route !== undefined && key !== undefined)
                        flights.set(key, route);
                    return resolved;
                }
                if (resolved === null || typeof resolved !== 'object')
                    return resolved; // nothing sane to reroute
                const selected = firstHealthyEntry(group.entries, pool) ?? fallbackEntry();
                const key = agentKeyOf(payload);
                if (selected === undefined || key === undefined) {
                    flights.clear(key);
                    return resolved; // everyone cooling or untrackable: pass through untouched
                }
                flights.set(key, selected);
                return reroute(resolved, selected);
            }
            catch (error) {
                ctx.logger?.warn?.('model-failover: agent/request routing failed, passing through: %o', error);
                return resolved; // behave as if the plugin were not installed
            }
            // Prepend: the OUTERMOST listener's return value is the final routing
            // config. agent-default-model (and any other outer listener) may return
            // its own config and discard downstream edits when the turn uses the
            // "Default" model selection — prepending here makes our failover reroute
            // the value the loop actually uses.
        }, { prepend: true });
        // DSH >= 0.2.2: step preparation fixes the route from the agent's model
        // selection, so chain steering happens here — select the first healthy
        // entry whenever the current selection sits on a cooling (exhausted)
        // account. Healthy in-chain manual choices are respected.
        const offPreStep = ctx.on('agent/pre-step', async (payload, next) => {
            const decision = await next();
            try {
                const model = payload?.agent?.model;
                if (model === undefined || typeof model.select !== 'function')
                    return decision;
                const current = payload.modelSelection ?? model.current();
                if (current === undefined)
                    return decision;
                const inChain = group.entries.some((entry) => entry.provider === current.provider);
                // Preflight: while the pool is degraded, verify the current selection
                // before entering the step. A dead account then costs one cheap probe
                // instead of one user-visible failed turn.
                if (inChain && probeOnDegraded && prober.capable && degraded()
                    && !pool.isCooling(current.provider) && pool.pendingReset(current.provider) === 0
                    && !prober.recentOk(current.provider)) {
                    const result = await prober.probe({ provider: current.provider, model: current.model });
                    if (!result.ok) {
                        penalize(current.provider, result.failure);
                        ctx.logger?.info?.('model-failover: preflight probe failed for %s/%s (%s) — steering away', current.provider, current.model, classifyFailure(result.failure));
                    }
                }
                const coolingNow = pool.isCooling(current.provider);
                let nextUp = firstHealthyEntry(group.entries, pool) ?? fallbackEntry();
                let changesRoute = nextUp !== undefined
                    && !(nextUp.provider === current.provider && nextUp.model === current.model);
                // The next hop may itself be dead (common after a restart): verify it
                // too, so one probe round resolves the chain instead of one turn per
                // account. chooseVerified cools every candidate that fails.
                if (changesRoute && nextUp !== undefined && probeOnDegraded && prober.capable
                    && degraded() && !prober.recentOk(nextUp.provider)) {
                    const verified = await chooseVerified(current.provider, nextUp);
                    if (verified === undefined)
                        return decision;
                    nextUp = verified;
                    changesRoute = !(nextUp.provider === current.provider && nextUp.model === current.model);
                }
                // Steer when the current route is cooling OR when the provider itself
                // said it cannot serve again until a later time (persisted across
                // restarts) and a clean alternative exists. A marked account with no
                // alternative stays selected: quota-floor accounts still serve normal
                // requests (see CHANGELOG 0.11.4).
                const markedReset = pool.pendingReset(current.provider) > 0;
                const cleanAlternative = nextUp !== undefined && pool.pendingReset(nextUp.provider) === 0;
                if (!coolingNow && !(markedReset && changesRoute && cleanAlternative)) {
                    if (!inChain)
                        return decision; // a healthy route outside the chain is the user's choice
                    const key = agentKeyOf(payload);
                    if (key !== undefined)
                        flights.set(key, group.entries.find((entry) => entry.provider === current.provider) ?? { provider: current.provider, model: current.model });
                    return decision;
                }
                if (!changesRoute || nextUp === undefined)
                    return decision;
                const switched = { provider: nextUp.provider, model: nextUp.model, ...current.reasoningEffort === undefined ? {} : { reasoningEffort: current.reasoningEffort } };
                model.select(switched);
                const key = agentKeyOf(payload);
                if (key !== undefined)
                    flights.set(key, nextUp);
                ctx.logger?.info?.('model-failover: %s/%s is %s — selecting %s/%s for the next step', current.provider, current.model, coolingNow ? 'cooling' : 'marked unavailable by the provider', nextUp.provider, nextUp.model);
                // The pre-step decision is ours to shape: rewriting selection steers
                // THIS step's route (preparation computed it before the provider cooled).
                if (decision !== null && typeof decision === 'object' && decision.kind === 'enter') {
                    return { ...decision, selection: switched };
                }
                return decision;
            }
            catch (error) {
                ctx.logger?.warn?.('model-failover: agent/pre-step steering failed, passing through: %o', error);
                return decision;
            }
        }, { prepend: true });
        // Prepend so this listener always runs before same-waterfall recovery
        // policies (e.g. llm-retry): the account is cooled no matter who decides
        // the retry, and downstream backoff is preserved by always delegating.
        const offRequestError = ctx.on('agent/request-error', async (payload, next) => {
            let delegated = false; // whether next() already ran — never run it twice
            try {
                const key = agentKeyOf(payload);
                const failure = payload?.failure;
                const klass = classifyFailure(failure);
                const stepKey = key === undefined ? undefined : `${key}|${payload?.turn}|${payload?.step}`;
                // The retry budget intentionally persists across the retries of one
                // turn/step (including downstream-driven ones) and is only pruned by size.
                const done = () => flights.clear(key);
                if (!retryOn.has(klass)) {
                    done();
                    return next();
                }
                // Resolve the account that was actually in flight; fall back to the
                // provider the loop reports, and never retry blindly when untrackable.
                const failed = flights.get(key)
                    ?? group.entries.find((entry) => entry.provider === payload?.provider);
                if (failed === undefined) {
                    done();
                    return next();
                }
                // A fresh failure can unlock a better durable selection: re-supervise
                // idle agents shortly after this turn settles.
                scheduleSupervision(SUPERVISION_FAILURE_DELAY_MS, true);
                const failureMessage = String(failure?.message ?? '');
                const statedRetryAfter = Math.max(finiteOr(failure?.providerRetryAfterMs, 0), retryAfterFromMessage(failureMessage, now()));
                // A provider-stated resume time is durable knowledge: persist it so a
                // restarted process does not re-try an account capped until next week
                // (2026-11-16: every restart re-burned one visible failure per dead
                // account because the pool lived only in memory).
                if (statedRetryAfter > 0)
                    pool.markReset(failed.provider, now() + statedRetryAfter);
                let retryAfter = statedRetryAfter;
                // GLM 1310 weekly-cap cooldown starts at one probe cycle and backs off
                // exponentially on repeat failures. The cap has a quota-floor effect
                // (account serves normal requests but not huge contexts), so cooling
                // until the multi-day reset mis-classifies live accounts as dead
                // (2026-11-14: cn/cn-2 fully usable, yet cooled for two days). A short
                // FIRST cooldown lets floor-effect accounts recover in minutes; a
                // GENUINELY dead account (tiny probe also 1310) repeats, and each
                // repeat multiplies the cooldown (15min → 1h → 6h → reset), so a
                // selection parked on a dead key costs at most a few visible failures
                // per day instead of one every probe cycle.
                if (/"code"\s*:\s*"1310"|7 天使用上限|7-day usage limit/i.test(failureMessage)) {
                    const last = lastWeeklyCap.get(failed.provider) ?? 0;
                    const repeats = now() - last < 24 * 60 * 60_000 ? (weeklyCapRepeats.get(failed.provider) ?? 0) + 1 : 1;
                    weeklyCapRepeats.set(failed.provider, repeats);
                    lastWeeklyCap.set(failed.provider, now());
                    const backoff = Math.min(REVIVABLE_WINDOW_MS * 4 ** (repeats - 1), retryAfter);
                    retryAfter = backoff;
                }
                else {
                    weeklyCapRepeats.delete(failed.provider);
                    lastWeeklyCap.delete(failed.provider);
                }
                noteFailure(failed.provider);
                pool.cool(failed.provider, Math.max(cooldownMs, retryAfter));
                // DSH >= 0.2.2: a same-step retry re-fires the step's FIXED route — it
                // cannot reach a different account (verified against the 0.2.2 loop:
                // prepareRequest reuses decision.selection). So on fatal classes we
                // cool, durably select the next healthy account (effective next step —
                // goal/task drivers and the user's next message route correctly), and
                // fail THIS step fast instead of burning retries on the dead route.
                // Provider-side rate limits carry account-level semantics (GLM 1302
                // 频率限制, 1308 5-hour cap, 1310 weekly cap): same-route backoff only
                // deepens the throttle. On the fixed-route architecture ANY retryOn
                // class with a healthy alternative therefore cools, durably selects the
                // next account, and fails this step fast.
                const model = payload?.agent?.model;
                if (model !== undefined && typeof model.select === 'function') {
                    const chainNext22 = firstHealthyEntry(group.entries, pool);
                    const fallbackNext22 = chainNext22 === undefined ? fallbackEntry() : undefined;
                    const nextUp22 = chainNext22 ?? fallbackNext22;
                    // Never re-select the route that just failed: with a short cooldown a
                    // cooling entry can be the only "healthy" entry again, and selecting
                    // it would loop on the dead account forever.
                    const repeatsFailure = nextUp22 !== undefined
                        && nextUp22.provider === failed.provider
                        && (nextUp22.model === failed.model || failed.model === '');
                    if (nextUp22 !== undefined && !repeatsFailure) {
                        // While degraded, verify the pick with a cheap probe: one probe
                        // round now resolves the chain, instead of one failed turn per dead
                        // account later (the 14:28 incident tried them one by one).
                        const verified = probeOnDegraded && prober.capable && degraded()
                            ? await chooseVerified(failed.provider, nextUp22)
                            : nextUp22;
                        const chosen = verified ?? firstHealthyEntry(group.entries, pool) ?? fallbackEntry();
                        if (chosen !== undefined) {
                            const probed = chosen.provider !== nextUp22.provider;
                            model.select({ provider: chosen.provider, model: chosen.model });
                            note(payload, failed.provider, chosen.provider, klass + ' [' + failureDetail(failure) + ']' + (probed ? '/probe' : ''), probed ? 'probe' : (fallbackNext22 !== undefined ? 'fallback' : 'chain'));
                            ctx.logger?.info?.('model-failover: %s failed (%s) — cooled, %s selected for the next step%s; this step fails fast', failed.provider, klass, chosen.provider, probed ? ' (verified by probe)' : '');
                            done();
                            return undefined;
                        }
                        // Every candidate failed the probe: fall through to the revive path.
                    }
                    // No healthy alternative on the fixed-route architecture. Delegating
                    // to llm-retry would burn its whole budget re-firing the SAME dead
                    // route (the 2026-11-14 incident: 5/5 retries on a weekly-capped
                    // account, round died). Instead: fail this step fast, and when a
                    // cooled entry has not been probed recently, revive it as the durable
                    // selection so the NEXT step probes it — recovery without waste.
                    const reviveCandidate = group.entries.find((entry) => pool.isCooling(entry.provider) && probeEligible(entry));
                    if (reviveCandidate !== undefined) {
                        lastRevive.set(reviveCandidate.provider, now());
                        pool.revive(reviveCandidate.provider);
                        model.select({ provider: reviveCandidate.provider, model: reviveCandidate.model });
                        note(payload, failed.provider, reviveCandidate.provider, klass + ' [' + failureDetail(failure) + ']/second-chance', 'second-chance');
                        ctx.logger?.info?.('model-failover: %s failed (%s) and every account is cooling — second-chance probe on %s next step (recharged?)', failed.provider, klass, reviveCandidate.provider);
                    }
                    else {
                        note(payload, failed.provider, failed.provider, klass + ' [' + failureDetail(failure) + '] (all cooling, fail fast)', 'chain');
                        ctx.logger?.warn?.('model-failover: %s failed (%s) and every account is cooling — failing fast (no same-route retry burn)', failed.provider, klass);
                    }
                    done();
                    return undefined;
                }
                // Legacy (< 0.2.2): instant failover by rewriting agent/request on retry.
                // backoff, so we answer { kind: 'retry' } directly instead of delegating
                // to llm-retry (whose listener would sleep on its exponential delay
                // before returning the same decision). Downstream recovery still handles
                // every case we cannot solve ourselves below.
                const used = budgets.spendChainHop(stepKey);
                const chainNext = firstHealthyEntry(group.entries, pool);
                const fallbackNext = chainNext === undefined ? fallbackEntry() : undefined;
                const nextUp = chainNext ?? fallbackNext;
                // Catalog-fallback hops get their own small budget so a group pass stays bounded.
                let fallbackOk = false;
                if (fallbackNext !== undefined)
                    fallbackOk = budgets.spendFallbackHop(stepKey) <= FALLBACK_HOPS_PER_STEP;
                if (nextUp !== undefined && (used <= group.entries.length || fallbackOk)) {
                    // Anti-thrash: three instant hops in one second can trip provider
                    // burst protection on otherwise healthy accounts. Pause briefly
                    // (or honor the provider's Retry-After when given) before retrying.
                    const hopDelay = retryAfter > 0 ? Math.min(retryAfter, 5000) : HOP_DELAY_MS;
                    if (hopDelay > 0 && payload?.signal?.aborted !== true) {
                        await sleep(hopDelay);
                    }
                    note(payload, failed.provider, nextUp.provider, klass + ' [' + failureDetail(failure) + ']', fallbackNext !== undefined ? 'fallback' : 'chain');
                    ctx.logger?.info?.('model-failover: %s/%s failed (%s) → switching to %s/%s (cooldown %d min)', failed.provider, failed.model, klass, nextUp.provider, nextUp.model, Math.round(Math.max(cooldownMs, retryAfter) / 60_000));
                    done();
                    return { kind: 'retry' };
                }
                // Second chance: every account is cooling, but the user may have
                // recharged one meanwhile. Revive the first cooled entry (chain order,
                // throttled to one probe per provider per REVIVE_INTERVAL_MS) and let
                // the real request itself probe it — success means real quota, a
                // retryable failure simply re-cools it at no extra cost.
                if (nextUp === undefined && used <= group.entries.length + 1) {
                    const candidate = group.entries.find((entry) => pool.isCooling(entry.provider) && probeEligible(entry));
                    if (candidate !== undefined) {
                        lastRevive.set(candidate.provider, now());
                        pool.revive(candidate.provider);
                        const model = payload?.agent?.model;
                        if (model !== undefined && typeof model.select === 'function') {
                            model.select({ provider: candidate.provider, model: candidate.model });
                        }
                        note(payload, failed.provider, candidate.provider, klass + ' [' + failureDetail(failure) + ']/second-chance', 'second-chance');
                        ctx.logger?.info?.('model-failover: every account is cooling — second-chance retry on %s (recharged?)', candidate.provider);
                        done();
                        return { kind: 'retry' };
                    }
                }
                let downstream;
                try {
                    downstream = await next();
                }
                catch (error) {
                    downstream = undefined;
                    ctx.logger?.warn?.('model-failover: downstream recovery failed: %o', error);
                }
                delegated = true; // next() ran (throwing or not): never call it again
                if (downstream?.kind === 'retry') {
                    done();
                    return downstream;
                }
                if (nextUp !== undefined) {
                    ctx.logger?.warn?.('model-failover: retry budget exhausted for %s after %d attempts — giving up to default handling', stepKey, used);
                }
                else {
                    ctx.logger?.warn?.('model-failover: %s failed (%s) and every account is cooling — giving up to default handling', failed.provider, klass);
                }
                done();
                return downstream;
            }
            catch (error) {
                ctx.logger?.warn?.('model-failover: agent/request-error listener failed, passing through: %o', error);
                // If next() already ran above, delegating again would execute downstream
                // recovery (e.g. llm-retry) twice; degrade to "no action" instead.
                return delegated ? undefined : next();
            }
        }, { prepend: true });
        // First pass after wiring: a restarted host often still carries a stale
        // (capped) selection from the previous process — repair it before the user
        // sends anything.
        if (probeOnDegraded)
            scheduleSupervision(internals.supervisionStartDelayMs ?? SUPERVISION_START_DELAY_MS);
        return () => {
            supervisionDisposed = true;
            if (supervisionTimer !== undefined) {
                clearTimeout(supervisionTimer);
                supervisionTimer = undefined;
            }
            offRequest();
            offPreStep();
            offRequestError();
        };
    };
    // Wire failures are captured to load.log before propagating: a plugin that
    // fails to arm must leave an external trace instead of vanishing into host
    // stdout (the 2026-11-01 blind-spot postmortem).
    const guardedWire = () => {
        try {
            return wire();
        }
        catch (error) {
            void writeLoadMarker(VERSION, 'wire failed: ' + String(error?.message ?? error));
            throw error;
        }
    };
    if (typeof ctx.effect === 'function') {
        ctx.effect(guardedWire, 'model-failover: volatile config wiring');
    }
    else {
        guardedWire();
    }
    return { pool };
}
