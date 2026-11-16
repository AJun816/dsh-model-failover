/**
 * Preflight probes: verify a candidate account with a one-token request before
 * committing to it, so a degraded chain resolves to a *working* account instead
 * of burning one user-visible failure per dead entry.
 *
 * Industry routers (LiteLLM, OpenRouter, one-api) do not call every candidate on
 * the happy path: they keep an ordered chain plus a circuit breaker and only
 * spend a request when the chain is known to be degraded. This module follows
 * that rule: probes run only while some account is cooling / carries a provider
 * reset, at most once per provider per TTL, and never when the host exposes no
 * stream API (then callers behave exactly as before).
 *
 * @module dsh-model-failover/probe
 */
/** A one-token probe: cheapest possible round trip that proves quota + auth + reachability. */
function probeRequest(entry, signal) {
    return {
        provider: entry.provider,
        model: entry.model,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
        maxTokens: 1,
        temperature: 0,
        signal,
    };
}
/**
 * Create the prober. Returns a permanently "capable: false" service when the
 * host has no stream API, so every caller degrades to chain-order behaviour.
 */
export function createProber(llm, options) {
    const { now, timeoutMs, cacheMs } = options;
    const stream = llm?.stream;
    const capable = typeof stream === 'function';
    /** provider -> the instant its last probe (or live traffic) proved it healthy. */
    const okAt = new Map();
    const inFlight = new Map();
    const recentOk = (provider) => {
        const at = okAt.get(provider);
        if (at === undefined)
            return false;
        if (now() - at > cacheMs) {
            okAt.delete(provider);
            return false;
        }
        return true;
    };
    const run = async (entry) => {
        if (!capable)
            return { ok: true };
        const controller = new AbortController();
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
        try {
            for await (const chunk of stream.call(llm, probeRequest(entry, controller.signal))) {
                // DSH delivers adapter failures as a terminal `finish` chunk with
                // reason.kind 'error'/'aborted' — it does not throw. Treat any other
                // chunk (or a clean finish) as proof that auth, quota, and transport
                // all worked.
                const record = chunk;
                const type = record?.type;
                if (type === 'finish') {
                    const kind = record?.reason?.kind;
                    if (kind === 'error' || kind === 'aborted') {
                        const failure = (record?.reason?.failure ?? { code: 'ABORTED', message: 'probe aborted' });
                        return { ok: false, failure };
                    }
                    okAt.set(entry.provider, now());
                    return { ok: true };
                }
                if (typeof type === 'string') {
                    okAt.set(entry.provider, now());
                    return { ok: true };
                }
            }
            // A stream that ends without any chunk still counts unless it timed out.
            if (timedOut)
                return { ok: false, failure: { code: 'NETWORK', message: 'probe timed out' } };
            okAt.set(entry.provider, now());
            return { ok: true };
        }
        catch (error) {
            if (timedOut)
                return { ok: false, failure: { code: 'NETWORK', message: 'probe timed out' } };
            // LlmError carries code/message/status; keep the original for classification.
            const failure = (error !== null && typeof error === 'object'
                ? error
                : { message: String(error) });
            return { ok: false, failure };
        }
        finally {
            clearTimeout(timer);
        }
    };
    const probe = (entry) => {
        if (!capable)
            return Promise.resolve({ ok: true });
        const existing = inFlight.get(entry.provider);
        if (existing !== undefined)
            return existing;
        const pending = run(entry).finally(() => { inFlight.delete(entry.provider); });
        inFlight.set(entry.provider, pending);
        return pending;
    };
    return {
        capable,
        probe,
        recentOk,
        markOk: (provider) => { okAt.set(provider, now()); },
        forget: (provider) => { okAt.delete(provider); },
    };
}
