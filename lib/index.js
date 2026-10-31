/**
 * dsh-model-failover — automatic model & account failover for DeepSeek Harness.
 *
 * Listens to the two public agent-loop waterfalls:
 *  - `agent/request`: routes every model call to the first healthy entry of
 *    the active fallback group (array order = failover order).
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
 * @module dsh-model-failover
 */
import z from '@deepseek-ai/schemastery';
export const name = 'model-failover';
export const inject = ['llm'];
/**
 * Runtime schema for {@link Config}.
 */
export const Config = z.object({
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
    fallbackToCatalog: z.boolean().default(true).volatile(),
    lastSwitches: z.array(z.object({
        at: z.number().required(),
        from: z.string().required(),
        to: z.string().required(),
        reason: z.string().required(),
        via: z.string().required(),
    })).default([]).volatile(),
});
/** Failure classes that can trigger a switchover. */
export const FAILURE_CLASSES = ['quota', 'rate-limit', 'auth', 'network', 'other'];
const CODE_CLASS = [
    [/^(ACCOUNT_)?QUOTA$/i, 'quota'],
    [/RATE_LIMIT/i, 'rate-limit'],
    [/^AUTH(ORIZATION|ENTICATION)?$/i, 'auth'],
    [/^(NETWORK|TIMEOUT|CONNECTION)/i, 'network'],
];
const MESSAGE_CLASS = [
    [/insufficient\s+balance|quota|额度|余额|使用上限|usage\s*limit/i, 'quota'],
    [/rate\s*limit|too many requests|限流|请求过于频繁|稍后(再试|重试)/i, 'rate-limit'],
    [/invalid\s+api\s*key|unauthorized|forbidden|authentication/i, 'auth'],
    [/network|econnreset|econnrefused|etimedout|fetch failed|timeout|overload|服务繁忙/i, 'network'],
];
/**
 * Parse a provider-stated resume time like "2026-11-05 17:10:49 后可继续使用"
 * (weekly/period usage caps) into remaining milliseconds. Local time assumed.
 */
export function retryAfterFromMessage(message, now = Date.now()) {
    if (typeof message !== 'string' || message === '')
        return 0;
    const hit = /(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(:\d{2})?)/.exec(message);
    if (hit === null)
        return 0;
    const time = hit[3] === undefined ? hit[2] + ':00' : hit[2];
    const until = Date.parse(hit[1] + 'T' + time);
    return Number.isFinite(until) ? Math.max(0, until - now) : 0;
}
const STATUS_CLASS = new Map([
    [402, 'quota'], [429, 'rate-limit'], [401, 'auth'], [403, 'auth'],
    [503, 'network'], [504, 'network'], [529, 'network'],
]);
/** Neutral LlmCallConfig fields safe to keep when the provider changes. */
const NEUTRAL_FIELDS = ['maxTokens', 'temperature'];
/**
 * Classify an LlmFailure into one of the failure classes. Code wins, message
 * keywords and HTTP status follow.
 */
export function classifyFailure(failure) {
    if (failure === null || failure === undefined || typeof failure !== 'object')
        return 'other';
    const code = String(failure.code ?? '');
    for (const [pattern, klass] of CODE_CLASS)
        if (pattern.test(code))
            return klass;
    // A numeric string code ("429", "1310"-style HTTP echoes) maps like a status.
    const numeric = /^\d{3}$/.test(code) ? Number(code) : undefined;
    const statusHit = STATUS_CLASS.get(failure.status ?? numeric ?? NaN);
    if (statusHit !== undefined)
        return statusHit;
    if (/^13[0-9]{2}$/.test(code))
        return code === '1302' ? 'rate-limit' : 'quota';
    const message = String(failure.message ?? '');
    for (const [pattern, klass] of MESSAGE_CLASS)
        if (pattern.test(message))
            return klass;
    return 'other';
}
/**
 * Build a fresh account-pool state machine. Exposed for tests.
 * @param options.cooldownMs default cooldown duration in milliseconds
 * @param options.now clock, injectable for tests
 */
export function createPool(options) {
    const { cooldownMs } = options;
    const now = options.now ?? (() => Date.now());
    const cooling = new Map();
    function cool(account, ms = cooldownMs) {
        const previous = cooling.get(account);
        const until = now() + ms;
        // A longer explicit cooldown (e.g. provider Retry-After) is never shortened.
        cooling.set(account, { until: Math.max(until, previous?.until ?? 0) });
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
    }
    function revive(account) {
        const wasCooling = cooling.get(account) !== undefined;
        cooling.delete(account);
        return wasCooling;
    }
    function snapshot() {
        const out = {};
        for (const [account, { until }] of cooling) {
            if (now() < until)
                out[account] = { coolingUntil: until };
        }
        return out;
    }
    return { cool, isCooling, recover, revive, snapshot };
}
function firstHealthyEntry(entries, pool) {
    for (const entry of entries) {
        if (!pool.isCooling(entry.provider))
            return entry;
    }
    return undefined;
}
/**
 * Resolve the active group from configuration. Unknown activeGroup falls
 * back to the first group.
 */
export function activeGroupOf(config) {
    if (!Array.isArray(config.groups) || config.groups.length === 0)
        return undefined;
    const wanted = config.activeGroup || config.groups[0]?.id;
    return config.groups.find((group) => group.id === wanted) ?? config.groups[0];
}
function finiteOr(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
}
/** Volatile fields may be plain values or live refs exposing .get(); read both. */
function valueOf(value) {
    if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
        try {
            return value.get();
        }
        catch {
            return undefined;
        }
    }
    return value;
}
function entriesOf(value) {
    const inner = valueOf(value);
    return Array.isArray(inner) ? inner : [];
}
function stringOf(value) {
    const inner = valueOf(value);
    return typeof inner === 'string' ? inner : '';
}
function stringListOf(value) {
    const inner = valueOf(value);
    return Array.isArray(inner) ? inner : [];
}
function boolOf(value, fallback) {
    const inner = valueOf(value);
    return typeof inner === 'boolean' ? inner : fallback;
}
function numberOr(value, fallback) {
    const inner = valueOf(value);
    return typeof inner === 'number' && Number.isFinite(inner) ? inner : fallback;
}
/** Rebuild the routed config, keeping only neutral fields across providers. */
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
/**
 * The session-record type for one failover switch. Plugin-authored records must
 * follow the official `plugin:` grammar (`plugin:` + lowercase slash-separated
 * segments) and are written through `appendPluginRecord`, which stamps the
 * envelope's `ignorable: true` marker so every harness build — including ones
 * that do not know the type — can keep reading the log. A plain required-event
 * append of a custom type writes a REQUIRED unknown event that the persistence
 * reader refuses with "unknown to this harness and not marked ignorable",
 * breaking history load for that session.
 */
const SWITCH_RECORD_TYPE = 'plugin:model-failover/switch';
/** Cached once resolved; a failed lookup retries on the next switch (rare). */
let pluginRecordWriter;
async function resolvePluginRecordWriter() {
    if (pluginRecordWriter !== undefined)
        return pluginRecordWriter;
    try {
        // Runtime lookup of the in-process host module (the same modules sibling
        // plugins like dsh-web-search-zhipu import statically). The computed
        // specifier keeps this build dependency-free; when the channel is missing
        // (older host, plain-node tests without the stub) we simply skip it.
        const specifier = '@deepseek-ai/dsh-session';
        const mod = await import(specifier);
        if (typeof mod.appendPluginRecord === 'function')
            pluginRecordWriter = mod.appendPluginRecord;
    }
    catch { /* best effort: retry on the next switch */ }
    return pluginRecordWriter;
}
/**
 * Resolved-once default switch-log location: <plugin root>/switches.log, i.e.
 * next to lib/ in the installed plugin directory. Derived from
 * import.meta.url so it works for every install channel (git URL, npm, local
 * path) and every user — never a machine-specific absolute path.
 */
let defaultSwitchLog = false;
async function resolveDefaultSwitchLog() {
    if (defaultSwitchLog !== false)
        return defaultSwitchLog;
    defaultSwitchLog = undefined;
    try {
        // Computed-specifier dynamic imports keep the build independent of
        // @types/node; in the installed plugin import.meta.url is
        // <plugin>/lib/index.js, so the plugin root is one dirname up.
        const urlSpecifier = 'node:url';
        const pathSpecifier = 'node:path';
        const fsSpecifier = 'node:fs';
        const urlMod = await import(urlSpecifier);
        const pathMod = await import(pathSpecifier);
        const fsMod = await import(fsSpecifier);
        const meta = import.meta;
        const here = meta.url === undefined ? undefined : urlMod.fileURLToPath?.(meta.url);
        if (here === undefined || pathMod.dirname === undefined || pathMod.join === undefined)
            return undefined;
        const dir = pathMod.dirname(pathMod.dirname(here));
        fsMod.mkdirSync?.(dir, { recursive: true });
        defaultSwitchLog = pathMod.join(dir, 'switches.log');
    }
    catch { /* best effort: the file-log channel is optional */ }
    return defaultSwitchLog;
}
/**
 * Record one failover switch through every official channel:
 *  - a plugin record (`plugin:model-failover/switch`, ignorable) in the turn's
 *    transcript log via `appendPluginRecord` — the only supported way for a
 *    plugin to add a session event;
 *  - a JSONL line in the plugin's own switch log;
 *  - the `lastSwitches` advisory field in our settings namespace, which the
 *    GUI card renders as a notice banner.
 * Each channel is individually optional; a failure in one never blocks the others.
 */
async function recordSwitch(ctx, payload, record, logFile) {
    // 1) session transcript plugin record (official ignorable channel; the plain
    //    append path is reserved for harness-known event types)
    try {
        const session = payload.agent?.session;
        if (session !== undefined) {
            const write = await resolvePluginRecordWriter();
            write?.(session, SWITCH_RECORD_TYPE, record);
        }
    }
    catch { /* best effort */ }
    // 2) plugin file log (types-free dynamic imports keep the build independent of @types/node)
    const logTarget = logFile ?? await resolveDefaultSwitchLog();
    if (logTarget !== undefined) {
        try {
            // @ts-ignore runtime-provided node builtin; typing it would force @types/node into the build
            const fs = await import('node:fs');
            fs.appendFileSync?.(logTarget, JSON.stringify(record) + '\n');
        }
        catch { /* best effort */ }
    }
    // 3) settings namespace (GUI notice); best effort with a describe-read-update cycle
    try {
        const settings = ctx.get?.('settings');
        if (settings === undefined)
            return;
        const described = await settings.describe();
        const view = described.namespaces?.find((row) => row.ns === 'model-failover');
        const history = [...(view?.value?.lastSwitches ?? []), record].slice(-5);
        await settings.update?.('model-failover', { lastSwitches: history }, view?.revision);
    }
    catch { /* best effort: never block the retry decision */ }
}
/**
 * Install the failover listeners.
 * @param ctx plugin context
 * @param config resolved plugin configuration
 * @param internals test hooks
 */
export function apply(ctx, config = {}, internals = {}) {
    const now = internals.now ?? (() => Date.now());
    /** Explicit log path (tests); production derives it from the plugin dir. */
    const logFile = internals.logFile;
    /** Record a switch through all channels without blocking the retry decision. */
    const note = (payload, from, to, reason, via) => {
        // Recording is advisory: swallow even programming errors so no switch can
        // ever surface as an unhandled rejection inside the host process.
        recordSwitch(ctx, payload, { at: now(), from, to, reason, via }, logFile)
            .catch(() => { });
    };
    const pool = internals.pool ?? createPool({ cooldownMs: 30 * 60_000, now });
    /** Which entry the current in-flight request uses, per agent key. */
    const inFlight = new Map();
    /** Consecutive failover retries per agent key and turn/step. */
    const retryBudget = new Map();
    /** Catalog-fallback hops per agent key and turn/step (separate small budget). */
    const fallbackBudget = new Map();
    /** Last second-chance revive per provider, throttling probes on fully-cooled pools. */
    const lastRevive = new Map();
    /** Minimum spacing between second-chance probes of one provider. */
    const REVIVE_INTERVAL_MS = 5 * 60_000;
    const agentKey = (payload) => {
        const agent = payload?.agent;
        const raw = agent?.session?.id ?? agent?.id;
        return raw === undefined || raw === null ? undefined : String(raw);
    };
    /**
     * Auto-discovered chain: one entry per configured provider (its first
     * model), in registry order. Built from the public llm service; refreshed
     * on adapter topology changes. Empty while the registry is unavailable.
     */
    let autoEntries = [];
    const llm = ctx.llm;
    const refreshAuto = async () => {
        if (llm === undefined)
            return;
        try {
            const entries = [];
            for (const provider of llm.listProviders()) {
                try {
                    const models = await llm.listModels(provider.id);
                    const first = models[0];
                    if (first !== undefined)
                        entries.push({ provider: provider.id, model: first.id });
                }
                catch { /* a provider whose catalog fails is skipped this round */ }
            }
            autoEntries = entries;
        }
        catch (error) {
            ;
            ctx.logger?.warn?.('model-failover: auto-discovery failed: %o', error);
        }
    };
    void refreshAuto();
    ctx.on('llm/adapters-updated', (() => { void refreshAuto(); }));
    /**
     * Wire the listeners from the current (volatile) config. Re-run by cordis
     * whenever a volatile field changes, so GUI edits apply without a restart;
     * the pool's cooling state deliberately survives re-wiring.
     */
    const wire = () => {
        const cooldownMs = numberOr(config.cooldownMinutes, 30) * 60_000;
        const retryOn = new Set(stringListOf(config.retryOn).length > 0 ? stringListOf(config.retryOn) : ['quota', 'rate-limit', 'auth', 'network']);
        const autoOn = boolOf(config.autoDiscover, true);
        const fallbackOn = boolOf(config.fallbackToCatalog, true);
        /** First healthy entry outside the active group (catalog fallback). */
        const fallbackEntry = () => {
            if (!fallbackOn || group === undefined)
                return undefined;
            const inGroup = new Set(group.entries.map((entry) => entry.provider));
            return autoEntries.find((entry) => !inGroup.has(entry.provider) && !pool.isCooling(entry.provider));
        };
        const groupsRaw = valueOf(config.groups);
        const groupsValue = Array.isArray(groupsRaw) ? groupsRaw : [];
        let group = activeGroupOf({ groups: groupsValue, activeGroup: stringOf(config.activeGroup) });
        if (groupsValue.length === 0 && autoOn) {
            group = { id: 'auto', entries: autoEntries };
        }
        if (group === undefined || group.entries.length === 0) {
            ;
            ctx.logger?.info?.('model-failover: no groups or entries configured — plugin stays inactive (pass-through)');
            return () => { };
        }
        ;
        ctx.logger?.info?.(`model-failover: active group "${group.id}" with ${group.entries.length} entries (${group.entries.map((e) => e.provider + '/' + e.model).join(' → ')})`);
        const offRequest = ctx.on('agent/request', async (payload, next) => {
            // Downstream (inner-listener) errors propagate unchanged: they are not
            // ours to swallow. Only OUR routing below degrades to pass-through.
            const resolved = await next();
            try {
                if (resolved === null || typeof resolved !== 'object')
                    return resolved; // nothing sane to reroute
                const selected = firstHealthyEntry(group.entries, pool) ?? fallbackEntry();
                const key = agentKey(payload);
                if (selected === undefined || key === undefined) {
                    if (key !== undefined)
                        inFlight.delete(key);
                    return resolved; // everyone cooling or untrackable: pass through untouched
                }
                if (inFlight.size > 64)
                    inFlight.clear(); // bounded: entries are per agent key, pruned on error paths
                inFlight.set(key, selected);
                return reroute(resolved, selected);
            }
            catch (error) {
                ;
                ctx.logger?.warn?.('model-failover: agent/request routing failed, passing through: %o', error);
                return resolved; // behave as if the plugin were not installed
            }
            // Prepend: the OUTERMOST listener's return value is the final routing
            // config. agent-default-model (and any other outer listener) may return
            // its own config and discard downstream edits when the turn uses the
            // "Default" model selection — prepending here makes our failover reroute
            // the value the loop actually uses.
        }, { prepend: true });
        // Prepend so this listener always runs before same-waterfall recovery
        // policies (e.g. llm-retry): the account is cooled no matter who decides
        // the retry, and downstream backoff is preserved by always delegating.
        const offRequestError = ctx.on('agent/request-error', async (payload, next) => {
            let delegated = false; // whether next() already ran — never run it twice
            try {
                const key = agentKey(payload);
                const failure = payload?.failure;
                const klass = classifyFailure(failure);
                const stepKey = key === undefined ? undefined : `${key}|${payload?.turn}|${payload?.step}`;
                // The retry budget intentionally persists across the retries of one
                // turn/step (including downstream-driven ones) and is only pruned by size.
                const done = () => {
                    if (key !== undefined)
                        inFlight.delete(key);
                };
                if (!retryOn.has(klass)) {
                    done();
                    return next();
                }
                // Resolve the account that was actually in flight; fall back to the
                // provider the loop reports, and never retry blindly when untrackable.
                const failed = (key === undefined ? undefined : inFlight.get(key))
                    ?? group.entries.find((entry) => entry.provider === payload?.provider);
                if (failed === undefined) {
                    done();
                    return next();
                }
                const retryAfter = Math.max(finiteOr(failure?.providerRetryAfterMs, 0), retryAfterFromMessage(failure?.message, now()));
                pool.cool(failed.provider, Math.max(cooldownMs, retryAfter));
                // Instant failover: switching to a DIFFERENT healthy account needs no
                // backoff, so we answer { kind: 'retry' } directly instead of delegating
                // to llm-retry (whose listener would sleep on its exponential delay
                // before returning the same decision). Downstream recovery still handles
                // every case we cannot solve ourselves below.
                let used = 1;
                if (stepKey === undefined) {
                    // Unkeyed agents cannot accumulate a budget; the pool bound still applies.
                    used = 1;
                }
                else {
                    used = (retryBudget.get(stepKey) ?? 0) + 1;
                    retryBudget.set(stepKey, used);
                }
                if (retryBudget.size > 1000)
                    retryBudget.clear();
                const groupNext = firstHealthyEntry(group.entries, pool);
                const fbNext = groupNext === undefined ? fallbackEntry() : undefined;
                const nextUp = groupNext ?? fbNext;
                // Catalog-fallback hops get their own small budget so a group pass stays bounded.
                let fallbackOk = false;
                if (fbNext !== undefined) {
                    if (stepKey === undefined)
                        fallbackOk = true;
                    else {
                        const used2 = (fallbackBudget.get(stepKey) ?? 0) + 1;
                        fallbackBudget.set(stepKey, used2);
                        if (fallbackBudget.size > 1000)
                            fallbackBudget.clear();
                        fallbackOk = used2 <= 2;
                    }
                }
                if (nextUp !== undefined && (used <= group.entries.length || fallbackOk)) {
                    note(payload, failed.provider, nextUp.provider, klass, fbNext !== undefined && groupNext === undefined ? 'fallback' : 'chain');
                    ctx.logger?.info?.('model-failover: %s/%s failed (%s) → switching to %s/%s (cooldown %d min)', failed.provider, failed.model, klass, nextUp.provider, nextUp.model, Math.round(Math.max(cooldownMs, retryAfter) / 60_000));
                    done();
                    return { kind: 'retry' };
                }
                // Second chance: every account is cooling, but the user may have
                // recharged one meanwhile. Revive the first cooled entry (chain order,
                // throttled to one probe per provider per REVIVE_INTERVAL_MS) and let the
                // real request itself probe it — success means real quota, a retryable
                // failure simply re-cools it (extends-only) at no extra cost.
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
                        note(payload, failed.provider, candidate.provider, klass + '/second-chance', 'second-chance');
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
                    ;
                    ctx.logger?.warn?.('model-failover: retry budget exhausted for %s after %d attempts — giving up to default handling', stepKey, used);
                }
                else {
                    ;
                    ctx.logger?.warn?.('model-failover: %s failed (%s) and every account is cooling — giving up to default handling', failed.provider, klass);
                }
                done();
                return downstream;
            }
            catch (error) {
                ;
                ctx.logger?.warn?.('model-failover: agent/request-error listener failed, passing through: %o', error);
                // If next() already ran above, delegating again would execute downstream
                // recovery (e.g. llm-retry) twice; degrade to "no action" instead.
                return delegated ? undefined : next();
            }
        }, { prepend: true });
        return () => {
            offRequest();
            offRequestError();
        };
    };
    if (typeof ctx.effect === 'function') {
        ctx.effect(wire, 'model-failover: volatile config wiring');
    }
    else {
        wire();
    }
    return { pool };
}
