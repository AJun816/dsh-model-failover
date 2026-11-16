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

import type { FailoverEntry, LlmFailure } from './types.js'

/** Minimal ambient declarations: the host is Node, but src compiles without node/DOM types. */
declare function setTimeout(handler: () => void, timeout: number): unknown
declare function clearTimeout(handle: unknown): void
declare const AbortController: new () => { readonly signal: unknown, abort(): void }

/** The stream surface a probe needs (a subset of the host LLM runtime). */
export interface ProbeStream {
  stream(options: unknown): AsyncIterable<unknown>
}

/** A provider that answers the probe is healthy; a throw is a real failure. */
export interface ProbeResult {
  ok: boolean
  failure?: LlmFailure
}

/** Probe service shared by the pre-step and failure paths. */
export interface Prober {
  /** Whether the host actually exposes a stream capability. */
  readonly capable: boolean
  /** Probe one entry; concurrent probes of the same provider share one request. */
  probe(entry: FailoverEntry): Promise<ProbeResult>
  /** True when this provider answered recently (probe or real traffic). */
  recentOk(provider: string): boolean
  /** Record health observed outside the prober. */
  markOk(provider: string): void
  /** Drop a cached verdict (the provider just failed a real request). */
  forget(provider: string): void
}

export interface ProberOptions {
  now: () => number
  /** Per-probe timeout; a hung provider must not stall the turn. */
  timeoutMs: number
  /** How long a successful probe keeps the provider verified. */
  cacheMs: number
}

/** A one-token probe: cheapest possible round trip that proves quota + auth + reachability. */
function probeRequest(entry: FailoverEntry, signal: unknown): unknown {
  return {
    provider: entry.provider,
    model: entry.model,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
    maxTokens: 1,
    temperature: 0,
    signal,
  }
}

/**
 * Create the prober. Returns a permanently "capable: false" service when the
 * host has no stream API, so every caller degrades to chain-order behaviour.
 */
export function createProber(llm: ProbeStream | undefined, options: ProberOptions): Prober {
  const { now, timeoutMs, cacheMs } = options
  const stream = llm?.stream
  const capable = typeof stream === 'function'
  /** provider -> the instant its last probe (or live traffic) proved it healthy. */
  const okAt = new Map<string, number>()
  const inFlight = new Map<string, Promise<ProbeResult>>()

  const recentOk = (provider: string): boolean => {
    const at = okAt.get(provider)
    if (at === undefined) return false
    if (now() - at > cacheMs) {
      okAt.delete(provider)
      return false
    }
    return true
  }

  const run = async (entry: FailoverEntry): Promise<ProbeResult> => {
    if (!capable) return { ok: true }
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
    try {
      for await (const chunk of (stream as ProbeStream['stream']).call(llm, probeRequest(entry, controller.signal))) {
        // DSH delivers adapter failures as a terminal `finish` chunk with
        // reason.kind 'error'/'aborted' — it does not throw. Treat any other
        // chunk (or a clean finish) as proof that auth, quota, and transport
        // all worked.
        const record = chunk as { type?: unknown, reason?: { kind?: unknown, failure?: unknown } } | null | undefined
        const type = record?.type
        if (type === 'finish') {
          const kind = record?.reason?.kind
          if (kind === 'error' || kind === 'aborted') {
            const failure = (record?.reason?.failure ?? { code: 'ABORTED', message: 'probe aborted' }) as LlmFailure
            return { ok: false, failure }
          }
          okAt.set(entry.provider, now())
          return { ok: true }
        }
        if (typeof type === 'string') {
          okAt.set(entry.provider, now())
          return { ok: true }
        }
      }
      // A stream that ends without any chunk still counts unless it timed out.
      if (timedOut) return { ok: false, failure: { code: 'NETWORK', message: 'probe timed out' } }
      okAt.set(entry.provider, now())
      return { ok: true }
    } catch (error) {
      if (timedOut) return { ok: false, failure: { code: 'NETWORK', message: 'probe timed out' } }
      // LlmError carries code/message/status; keep the original for classification.
      const failure = (error !== null && typeof error === 'object'
        ? error
        : { message: String(error) }) as LlmFailure
      return { ok: false, failure }
    } finally {
      clearTimeout(timer)
    }
  }

  const probe = (entry: FailoverEntry): Promise<ProbeResult> => {
    if (!capable) return Promise.resolve({ ok: true })
    const existing = inFlight.get(entry.provider)
    if (existing !== undefined) return existing
    const pending = run(entry).finally(() => { inFlight.delete(entry.provider) })
    inFlight.set(entry.provider, pending)
    return pending
  }

  return {
    capable,
    probe,
    recentOk,
    markOk: (provider: string) => { okAt.set(provider, now()) },
    forget: (provider: string) => { okAt.delete(provider) },
  }
}
