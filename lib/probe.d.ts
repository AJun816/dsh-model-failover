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
import type { FailoverEntry, LlmFailure } from './types.js';
/** The stream surface a probe needs (a subset of the host LLM runtime). */
export interface ProbeStream {
    stream(options: unknown): AsyncIterable<unknown>;
}
/** A provider that answers the probe is healthy; a throw is a real failure. */
export interface ProbeResult {
    ok: boolean;
    failure?: LlmFailure;
}
/** Probe service shared by the pre-step and failure paths. */
export interface Prober {
    /** Whether the host actually exposes a stream capability. */
    readonly capable: boolean;
    /** Probe one entry; concurrent probes of the same provider share one request. */
    probe(entry: FailoverEntry): Promise<ProbeResult>;
    /** True when this provider answered recently (probe or real traffic). */
    recentOk(provider: string): boolean;
    /** Record health observed outside the prober. */
    markOk(provider: string): void;
    /** Drop a cached verdict (the provider just failed a real request). */
    forget(provider: string): void;
}
export interface ProberOptions {
    now: () => number;
    /** Per-probe timeout; a hung provider must not stall the turn. */
    timeoutMs: number;
    /** How long a successful probe keeps the provider verified. */
    cacheMs: number;
}
/**
 * Create the prober. Returns a permanently "capable: false" service when the
 * host has no stream API, so every caller degrades to chain-order behaviour.
 */
export declare function createProber(llm: ProbeStream | undefined, options: ProberOptions): Prober;
