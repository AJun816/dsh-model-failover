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
export { createPool } from './pool.js';
export { activeGroupOf };
export { ConfigBinding as Config };
export { VERSION };
/** Neutral LlmCallConfig fields safe to keep when the provider changes. */
const NEUTRAL_FIELDS = ['maxTokens', 'temperature'];
/** Minimum spacing between second-chance probes of one provider. */
const REVIVE_INTERVAL_MS = 5 * 60_000;
/** Pause before an instant failover hop; providers burst-limit rapid switches. */
const HOP_DELAY_MS = 400;
/** Hard caps so the per-agent bookkeeping maps can never grow unbounded. */
const IN_FLIGHT_CAP = 64;
const BUDGET_CAP = 1_000;
/** Catalog-fallback hops per turn/step: a small budget of their own. */
const FALLBACK_HOPS_PER_STEP = 2;
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
    const pool = internals.pool ?? createPool({ cooldownMs: 30 * 60_000, now });
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
                    const healthy = firstHealthyEntry(group.entries, pool) ?? fallbackEntry();
                    const key = agentKeyOf(payload);
                    if (healthy !== undefined && key !== undefined)
                        flights.set(key, healthy);
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
                const coolingNow = pool.isCooling(current.provider);
                const inChain = group.entries.some((entry) => entry.provider === current.provider);
                if (!coolingNow) {
                    if (!inChain)
                        return decision; // a healthy route outside the chain is the user's choice
                    const key = agentKeyOf(payload);
                    if (key !== undefined)
                        flights.set(key, group.entries.find((entry) => entry.provider === current.provider) ?? { provider: current.provider, model: current.model });
                    return decision;
                }
                const nextUp = firstHealthyEntry(group.entries, pool) ?? fallbackEntry();
                if (nextUp === undefined || (nextUp.provider === current.provider && nextUp.model === current.model))
                    return decision;
                const switched = { provider: nextUp.provider, model: nextUp.model, ...current.reasoningEffort === undefined ? {} : { reasoningEffort: current.reasoningEffort } };
                model.select(switched);
                const key = agentKeyOf(payload);
                if (key !== undefined)
                    flights.set(key, nextUp);
                ctx.logger?.info?.('model-failover: %s/%s is cooling — selecting %s/%s for the next step', current.provider, current.model, nextUp.provider, nextUp.model);
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
                const retryAfter = Math.max(finiteOr(failure?.providerRetryAfterMs, 0), retryAfterFromMessage(failure?.message, now()));
                pool.cool(failed.provider, Math.max(cooldownMs, retryAfter));
                // DSH >= 0.2.2: a same-step retry re-fires the step's FIXED route — it
                // cannot reach a different account (verified against the 0.2.2 loop:
                // prepareRequest reuses decision.selection). So on fatal classes we
                // cool, durably select the next healthy account (effective next step —
                // goal/task drivers and the user's next message route correctly), and
                // fail THIS step fast instead of burning retries on the dead route.
                // Hard-cap rate limits (weekly/daily quota ceilings like GLM 1310) are
                // fatal for the account until reset; ordinary transient 429s are not.
                const capLike = klass === 'rate-limit'
                    && /上限|超限|额度|exceeded|insufficient|1310/i.test(String(failure?.message ?? '') + String(failure?.code ?? ''));
                const fatal = klass === 'quota' || klass === 'auth' || capLike;
                const model = payload?.agent?.model;
                if (fatal && model !== undefined && typeof model.select === 'function') {
                    const chainNext22 = firstHealthyEntry(group.entries, pool);
                    const fallbackNext22 = chainNext22 === undefined ? fallbackEntry() : undefined;
                    const nextUp22 = chainNext22 ?? fallbackNext22;
                    if (nextUp22 !== undefined) {
                        model.select({ provider: nextUp22.provider, model: nextUp22.model });
                        note(payload, failed.provider, nextUp22.provider, klass + ' [' + failureDetail(failure) + ']', fallbackNext22 !== undefined ? 'fallback' : 'chain');
                        ctx.logger?.info?.('model-failover: %s fatal (%s) — cooled, %s selected for the next step; this step fails fast', failed.provider, klass, nextUp22.provider);
                    }
                    else {
                        note(payload, failed.provider, failed.provider, klass + ' [' + failureDetail(failure) + '] (all cooling)', 'chain');
                        ctx.logger?.warn?.('model-failover: %s fatal (%s) and every account is cooling — failing to default handling', failed.provider, klass);
                    }
                    done();
                    return undefined;
                }
                // DSH >= 0.2.2, non-fatal classes (transient 429, network blips): the
                // account is cooled (future steps steer away), but THIS step's bounded
                // same-route recovery belongs to downstream policy (llm-retry backoff).
                if (model !== undefined && typeof model.select === 'function') {
                    note(payload, failed.provider, failed.provider, klass + ' [' + failureDetail(failure) + '] (transient, delegated)', 'chain');
                    done();
                    return next();
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
                    const candidate = group.entries.find((entry) => {
                        if (!pool.isCooling(entry.provider))
                            return false;
                        const last = lastRevive.get(entry.provider) ?? Number.NEGATIVE_INFINITY;
                        return now() - last >= REVIVE_INTERVAL_MS;
                    });
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
        return () => {
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
