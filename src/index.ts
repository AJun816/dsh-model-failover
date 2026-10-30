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

import z from '@deepseek-ai/schemastery'
import type { LlmCallConfig, LlmFailure } from '@deepseek-ai/dsh-llm'

/**
 * The slice of the agent loop's request-error recovery action this plugin
 * uses. Declared locally so the plugin compiles against any published
 * @deepseek-ai/dsh-agent version (structural, upgrade-tolerant).
 */
export type RequestErrorAction = { kind: 'retry' } | undefined

export const name = 'model-failover'
export const inject = []

/** One fallback-hop: a provider (account) route plus the model to call on it. */
export interface FailoverEntry {
  provider: string
  model: string
}

/** A named, ordered fallback chain. */
export interface FailoverGroup {
  id: string
  entries: FailoverEntry[]
}

/** Plugin configuration; lives in the user's cordis.patch.yml patch layer. */
export interface Config {
  groups?: FailoverGroup[]
  activeGroup?: string
  cooldownMinutes?: number
  retryOn?: string[]
}

/**
 * Runtime schema for {@link Config}.
 */
export const Config: z<Config> = z.object({
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
}) as unknown as z<Config>

/** Failure classes that can trigger a switchover. */
export const FAILURE_CLASSES = ['quota', 'rate-limit', 'auth', 'network', 'other'] as const

export type FailureClass = typeof FAILURE_CLASSES[number]

const CODE_CLASS: readonly (readonly [RegExp, FailureClass])[] = [
  [/^(ACCOUNT_)?QUOTA$/i, 'quota'],
  [/RATE_LIMIT/i, 'rate-limit'],
  [/^AUTH(ORIZATION|ENTICATION)?$/i, 'auth'],
  [/^(NETWORK|TIMEOUT|CONNECTION)/i, 'network'],
]

const MESSAGE_CLASS: readonly (readonly [RegExp, FailureClass])[] = [
  [/insufficient\s+balance|quota|额度|余额/i, 'quota'],
  [/rate\s*limit|too many requests/i, 'rate-limit'],
  [/invalid\s+api\s*key|unauthorized|forbidden|authentication/i, 'auth'],
  [/network|econnreset|econnrefused|etimedout|fetch failed|timeout|overload|服务繁忙/i, 'network'],
]

const STATUS_CLASS: ReadonlyMap<number, FailureClass> = new Map([
  [402, 'quota'], [429, 'rate-limit'], [401, 'auth'], [403, 'auth'],
  [503, 'network'], [504, 'network'], [529, 'network'],
])

/** Neutral LlmCallConfig fields safe to keep when the provider changes. */
const NEUTRAL_FIELDS = ['maxTokens', 'temperature'] as const

/**
 * Classify an LlmFailure into one of the failure classes. Code wins, message
 * keywords and HTTP status follow.
 */
export function classifyFailure(failure: LlmFailure | { message?: string, code?: string, status?: number } | null | undefined): FailureClass {
  if (failure === null || failure === undefined || typeof failure !== 'object') return 'other'
  const code = String(failure.code ?? '')
  for (const [pattern, klass] of CODE_CLASS) if (pattern.test(code)) return klass
  const statusHit = STATUS_CLASS.get(failure.status ?? NaN)
  if (statusHit !== undefined) return statusHit
  const message = String(failure.message ?? '')
  for (const [pattern, klass] of MESSAGE_CLASS) if (pattern.test(message)) return klass
  return 'other'
}

/** Account-level cooldown state machine. Cooling is keyed by provider. */
export interface AccountPool {
  cool(account: string, ms?: number): void
  isCooling(account: string): boolean
  recover(account: string): void
  snapshot(): Record<string, { coolingUntil: number }>
}

/**
 * Build a fresh account-pool state machine. Exposed for tests.
 * @param options.cooldownMs default cooldown duration in milliseconds
 * @param options.now clock, injectable for tests
 */
export function createPool(options: { cooldownMs: number, now?: () => number }): AccountPool {
  const { cooldownMs } = options
  const now = options.now ?? (() => Date.now())
  const cooling = new Map<string, { until: number }>()

  function cool(account: string, ms: number = cooldownMs): void {
    const previous = cooling.get(account)
    const until = now() + ms
    // A longer explicit cooldown (e.g. provider Retry-After) is never shortened.
    cooling.set(account, { until: Math.max(until, previous?.until ?? 0) })
  }

  function isCooling(account: string): boolean {
    const hit = cooling.get(account)
    if (hit === undefined) return false
    if (now() >= hit.until) {
      cooling.delete(account) // cooldown auto-recovery
      return false
    }
    return true
  }

  function recover(account: string): void {
    cooling.delete(account)
  }

  function snapshot(): Record<string, { coolingUntil: number }> {
    const out: Record<string, { coolingUntil: number }> = {}
    for (const [account, { until }] of cooling) {
      if (now() < until) out[account] = { coolingUntil: until }
    }
    return out
  }

  return { cool, isCooling, recover, snapshot }
}

function firstHealthyEntry(entries: readonly FailoverEntry[], pool: AccountPool): FailoverEntry | undefined {
  for (const entry of entries) {
    if (!pool.isCooling(entry.provider)) return entry
  }
  return undefined
}

/**
 * Resolve the active group from configuration. Unknown activeGroup falls
 * back to the first group.
 */
export function activeGroupOf(config: Config): FailoverGroup | undefined {
  if (!Array.isArray(config.groups) || config.groups.length === 0) return undefined
  const wanted = config.activeGroup || config.groups[0]?.id
  return config.groups.find((group) => group.id === wanted) ?? config.groups[0]
}

function finiteOr(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

/** Rebuild the routed config, keeping only neutral fields across providers. */
function reroute(resolved: LlmCallConfig, selected: FailoverEntry): LlmCallConfig {
  const out: Record<string, unknown> = selected.provider === resolved.provider ? { ...resolved } : {}
  for (const field of NEUTRAL_FIELDS) {
    if (resolved[field] !== undefined) out[field] = resolved[field]
  }
  out.provider = selected.provider
  out.model = selected.model
  return out as unknown as LlmCallConfig
}

/** The slice of cordis Context this plugin touches; keeps coupling minimal. */
interface ListenerContext {
  on(event: string, listener: (payload: any, next: () => Promise<any>) => Promise<any>, options?: { prepend?: boolean }): () => void
  /** cordis effect: re-runs the factory when volatile config it reads changes. */
  effect?: (factory: () => () => void, label?: string) => void
  logger?: {
    info?: (format: string, ...args: unknown[]) => void
    warn?: (format: string, ...args: unknown[]) => void
  }
}

/** Test hooks for the apply() wiring. */
export interface ApplyInternals {
  pool?: AccountPool
  now?: () => number
}

/** Waterfall payload shapes this plugin reads (structural, upgrade-tolerant). */
interface WaterfallPayload {
  agent?: { id?: unknown, session?: { id?: unknown } }
  turn?: number
  step?: number
  provider?: string
  failure?: LlmFailure
}

/**
 * Install the failover listeners.
 * @param ctx plugin context
 * @param config resolved plugin configuration
 * @param internals test hooks
 */
export function apply(ctx: ListenerContext, config: Config = {}, internals: ApplyInternals = {}): { pool: AccountPool } {
  const now = internals.now ?? (() => Date.now())
  const pool = internals.pool ?? createPool({ cooldownMs: 30 * 60_000, now })

  /** Which entry the current in-flight request uses, per agent key. */
  const inFlight = new Map<string, FailoverEntry>()
  /** Consecutive failover retries per agent key and turn/step. */
  const retryBudget = new Map<string, number>()

  const agentKey = (payload: WaterfallPayload | undefined): string | undefined => {
    const agent = payload?.agent
    const raw = agent?.session?.id ?? agent?.id
    return raw === undefined || raw === null ? undefined : String(raw)
  }

  /**
   * Wire the listeners from the current (volatile) config. Re-run by cordis
   * whenever a volatile field changes, so GUI edits apply without a restart;
   * the pool's cooling state deliberately survives re-wiring.
   */
  const wire = (): (() => void) => {
    const group = activeGroupOf(config)
    const cooldownMs = finiteOr(config.cooldownMinutes, 30) * 60_000
    const retryOn = new Set(Array.isArray(config.retryOn) ? config.retryOn : ['quota', 'rate-limit', 'auth', 'network'])

    if (group === undefined || group.entries.length === 0) {
      ;(ctx as ListenerContext).logger?.info?.('model-failover: no groups or entries configured — plugin stays inactive (pass-through)')
      return () => {}
    }
    ;(ctx as ListenerContext).logger?.info?.(`model-failover: active group "${group.id}" with ${group.entries.length} entries (${group.entries.map((e) => e.provider + '/' + e.model).join(' → ')})`)

    const offRequest = (ctx as ListenerContext).on('agent/request', async (payload: WaterfallPayload, next: () => Promise<LlmCallConfig>) => {
    try {
      const resolved = await next()
      const selected = firstHealthyEntry(group.entries, pool)
      const key = agentKey(payload)
      if (selected === undefined || key === undefined) {
        if (key !== undefined) inFlight.delete(key)
        return resolved // everyone cooling or untrackable: pass through untouched
      }
      inFlight.set(key, selected)
      return reroute(resolved, selected)
    } catch (error) {
      ;(ctx as ListenerContext).logger?.warn?.('model-failover: agent/request listener failed, passing through: %o', error)
      throw error
    }
  })

    // Prepend so this listener always runs before same-waterfall recovery
    // policies (e.g. llm-retry): the account is cooled no matter who decides
    // the retry, and downstream backoff is preserved by always delegating.
    const offRequestError = (ctx as ListenerContext).on('agent/request-error', async (payload: WaterfallPayload, next: () => Promise<RequestErrorAction | undefined>) => {
    try {
      const key = agentKey(payload)
      const failure = payload?.failure
      const klass = classifyFailure(failure)
      const stepKey = key === undefined ? undefined : `${key}|${payload?.turn}|${payload?.step}`

      // The retry budget intentionally persists across the retries of one
      // turn/step (including downstream-driven ones) and is only pruned by size.
      const done = (): void => {
        if (key !== undefined) inFlight.delete(key)
      }

      if (!retryOn.has(klass)) {
        done()
        return next()
      }

      // Resolve the account that was actually in flight; fall back to the
      // provider the loop reports, and never retry blindly when untrackable.
      const failed = (key === undefined ? undefined : inFlight.get(key))
        ?? group.entries.find((entry) => entry.provider === payload?.provider)
      if (failed === undefined) {
        done()
        return next()
      }
      const retryAfter = finiteOr(failure?.providerRetryAfterMs, 0)
      pool.cool(failed.provider, Math.max(cooldownMs, retryAfter))

      // Always delegate: downstream recovery (llm-retry backoff) wins if it
      // has one; its retry re-enters agent/request, which now skips the
      // cooled account.
      let downstream: RequestErrorAction | undefined
      try {
        downstream = await next()
      } catch (error) {
        downstream = undefined
        ;(ctx as ListenerContext).logger?.warn?.('model-failover: downstream recovery failed: %o', error)
      }
      if (downstream?.kind === 'retry') {
        done()
        return downstream
      }

      let used = 1
      if (stepKey === undefined) {
        // Unkeyed agents cannot accumulate a budget; the pool bound still applies.
        used = 1
      } else {
        used = (retryBudget.get(stepKey) ?? 0) + 1
        retryBudget.set(stepKey, used)
      }
      if (retryBudget.size > 1000) retryBudget.clear()
      if (used > group.entries.length) {
        ;(ctx as ListenerContext).logger?.warn?.(
          'model-failover: retry budget exhausted for %s after %d attempts — giving up to default handling',
          stepKey, used,
        )
        done()
        return downstream
      }

      const nextUp = firstHealthyEntry(group.entries, pool)
      if (nextUp === undefined) {
        ;(ctx as ListenerContext).logger?.warn?.(
          'model-failover: %s failed (%s) and every account is cooling — giving up to default handling',
          failed.provider, klass,
        )
        done()
        return downstream
      }
      ;(ctx as ListenerContext).logger?.info?.(
        'model-failover: %s/%s failed (%s) → switching to %s/%s (cooldown %d min)',
        failed.provider, failed.model,
        klass,
        nextUp.provider, nextUp.model,
        Math.round(Math.max(cooldownMs, retryAfter) / 60_000),
      )
      done()
      return { kind: 'retry' }
    } catch (error) {
      ;(ctx as ListenerContext).logger?.warn?.('model-failover: agent/request-error listener failed, passing through: %o', error)
      return next()
    }
    }, { prepend: true })

    return () => {
      offRequest()
      offRequestError()
    }
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(wire, 'model-failover: volatile config wiring')
  } else {
    wire()
  }
  return { pool }
}
