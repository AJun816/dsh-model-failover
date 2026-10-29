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

export const name = 'model-failover'
export const inject = []

/** @typedef {{ provider: string, model: string }} FailoverEntry */
/** @typedef {{ id: string, entries: FailoverEntry[] }} FailoverGroup */

/**
 * Plugin configuration schema (lives in the user's cordis.patch.yml patch
 * layer, so it survives DSH upgrades).
 */
export const Config = z.object({
  groups: z.array(z.object({
    id: z.string().required(),
    entries: z.array(z.object({
      provider: z.string().required(),
      model: z.string().required(),
    })).required(),
  })).default([]),
  activeGroup: z.string().default(''),
  cooldownMinutes: z.number().default(30),
  retryOn: z.array(z.string()).default(['quota', 'rate-limit', 'auth', 'network']),
})

/** Failure classes that can trigger a switchover. */
export const FAILURE_CLASSES = ['quota', 'rate-limit', 'auth', 'network', 'other']

const CODE_CLASS = [
  [/^(ACCOUNT_)?QUOTA$/i, 'quota'],
  [/RATE_LIMIT/i, 'rate-limit'],
  [/^AUTH(ORIZATION|ENTICATION)?$/i, 'auth'],
  [/^(NETWORK|TIMEOUT|CONNECTION)/i, 'network'],
]

const MESSAGE_CLASS = [
  [/insufficient\s+balance|quota|额度|余额/i, 'quota'],
  [/rate\s*limit|too many requests/i, 'rate-limit'],
  [/invalid\s+api\s*key|unauthorized|forbidden|authentication/i, 'auth'],
  [/network|econnreset|econnrefused|etimedout|fetch failed|timeout|overload|服务繁忙/i, 'network'],
]

const STATUS_CLASS = new Map([
  [402, 'quota'], [429, 'rate-limit'], [401, 'auth'], [403, 'auth'],
  [503, 'network'], [504, 'network'], [529, 'network'],
])

/** Neutral LlmCallConfig fields safe to keep when the provider changes. */
const NEUTRAL_FIELDS = ['maxTokens', 'temperature']

/**
 * Classify an LlmFailure ({ message, code, status? }) into one of the
 * failure classes. Code wins, message keywords and HTTP status follow.
 * @param {{ message?: string, code?: string, status?: number }} failure
 * @returns {string} one of FAILURE_CLASSES
 */
export function classifyFailure(failure) {
  if (failure === null || typeof failure !== 'object') return 'other'
  const code = String(failure.code ?? '')
  for (const [pattern, klass] of CODE_CLASS) if (pattern.test(code)) return klass
  if (STATUS_CLASS.has(failure.status)) return STATUS_CLASS.get(failure.status)
  const message = String(failure.message ?? '')
  for (const [pattern, klass] of MESSAGE_CLASS) if (pattern.test(message)) return klass
  return 'other'
}

/**
 * Build a fresh account-pool state machine. Cooling is keyed by provider
 * (account), not provider/model: an exhausted account cools every model it
 * serves. Exposed for tests.
 * @param {object} options
 * @param {number} options.cooldownMs default cooldown duration in milliseconds
 * @param {() => number} [options.now] clock, injectable for tests
 */
export function createPool({ cooldownMs, now = () => Date.now() }) {
  /** @type {Map<string, { until: number }>} cooling accounts by provider */
  const cooling = new Map()

  function cool(account, ms = cooldownMs) {
    const previous = cooling.get(account)
    const until = now() + ms
    // A longer explicit cooldown (e.g. provider Retry-After) is never shortened.
    cooling.set(account, { until: Math.max(until, previous?.until ?? 0) })
  }

  function isCooling(account) {
    const hit = cooling.get(account)
    if (hit === undefined) return false
    if (now() >= hit.until) {
      cooling.delete(account) // cooldown auto-recovery
      return false
    }
    return true
  }

  function recover(account) {
    cooling.delete(account)
  }

  function snapshot() {
    const out = {}
    for (const [account, { until }] of cooling) {
      if (now() < until) out[account] = { coolingUntil: until }
    }
    return out
  }

  return { cool, isCooling, recover, snapshot }
}

function firstHealthyEntry(entries, pool) {
  for (const entry of entries) {
    if (!pool.isCooling(entry.provider)) return entry
  }
  return undefined
}

/**
 * Resolve the active group from configuration.
 * @param {Config} config
 * @returns {FailoverGroup | undefined}
 */
export function activeGroupOf(config) {
  if (!Array.isArray(config.groups) || config.groups.length === 0) return undefined
  const wanted = config.activeGroup || config.groups[0].id
  return config.groups.find((group) => group.id === wanted) ?? config.groups[0]
}

function finiteOr(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

/** Rebuild the routed config, keeping only neutral fields across providers. */
function reroute(resolved, selected) {
  const out = selected.provider === resolved.provider ? { ...resolved } : {}
  for (const field of NEUTRAL_FIELDS) {
    if (resolved[field] !== undefined) out[field] = resolved[field]
  }
  out.provider = selected.provider
  out.model = selected.model
  return out
}

/**
 * Install the failover listeners.
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context
 * @param {Config} config resolved plugin configuration
 * @param {{ pool?: ReturnType<typeof createPool>, now?: () => number }} [internals] test hooks
 */
export function apply(ctx, config = {}, internals = {}) {
  const now = internals.now ?? (() => Date.now())
  const cooldownMs = finiteOr(config.cooldownMinutes, 30) * 60_000
  const retryOn = new Set(Array.isArray(config.retryOn) ? config.retryOn : ['quota', 'rate-limit', 'auth', 'network'])
  const pool = internals.pool ?? createPool({ cooldownMs, now })
  const group = activeGroupOf(config)

  if (group === undefined || group.entries.length === 0) {
    ctx?.logger?.info?.('model-failover: no groups or entries configured — plugin stays inactive (pass-through)')
    return { pool }
  }
  ctx?.logger?.info?.(`model-failover: active group "${group.id}" with ${group.entries.length} entries (${group.entries.map((e) => e.provider + '/' + e.model).join(' → ')})`)

  /**
   * Which entry the current in-flight request uses, per agent key. Cleared
   * after every request-error handling so a stale entry can never cool an
   * account that is not actually in flight.
   * @type {Map<string, FailoverEntry>}
   */
  const inFlight = new Map()
  /**
   * Consecutive failover retries per agent key and turn/step, bounded so one
   * step can never loop the pool more than once per entry.
   * @type {Map<string, number>}
   */
  const retryBudget = new Map()

  const agentKey = (payload) => {
    const agent = payload?.agent ?? payload?.session?.agent
    const raw = agent?.session?.id ?? agent?.id
    return raw === undefined || raw === null ? undefined : String(raw)
  }

  ctx.on('agent/request', async (payload, next) => {
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
      ctx?.logger?.warn?.('model-failover: agent/request listener failed, passing through: %o', error)
      throw error
    }
  })

  // Prepend so this listener always runs before same-waterfall recovery
  // policies (e.g. llm-retry): the account is cooled no matter who decides
  // the retry, and downstream backoff is preserved by always delegating.
  ctx.on('agent/request-error', async (payload, next) => {
    try {
      const key = agentKey(payload)
      const failure = payload?.failure
      const klass = classifyFailure(failure)
      const stepKey = key === undefined ? undefined : `${key}|${payload?.turn}|${payload?.step}`

      // The retry budget intentionally persists across the retries of one
      // turn/step (including downstream-driven ones) and is only pruned by size.
      const done = () => {
        if (key !== undefined) inFlight.delete(key)
      }

      if (!retryOn.has(klass)) {
        done()
        return next()
      }

      // Resolve the account that was actually in flight; fall back to the
      // provider the loop reports, and never retry blindly when untrackable.
      const failed = inFlight.get(key)
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
      let downstream
      try {
        downstream = await next()
      } catch (error) {
        downstream = undefined
        ctx?.logger?.warn?.('model-failover: downstream recovery failed: %o', error)
      }
      if (downstream?.kind === 'retry') {
        done()
        return downstream
      }

      const used = (retryBudget.get(stepKey) ?? 0) + 1
      retryBudget.set(stepKey, used)
      if (retryBudget.size > 1000) retryBudget.clear()
      if (used > group.entries.length) {
        ctx?.logger?.warn?.(
          'model-failover: retry budget exhausted for %s after %d attempts — giving up to default handling',
          stepKey, used,
        )
        done()
        return downstream
      }

      const nextUp = firstHealthyEntry(group.entries, pool)
      if (nextUp === undefined) {
        ctx?.logger?.warn?.(
          'model-failover: %s failed (%s) and every account is cooling — giving up to default handling',
          failed.provider, klass,
        )
        done()
        return downstream
      }
      ctx?.logger?.info?.(
        'model-failover: %s/%s failed (%s) → switching to %s/%s (cooldown %d min)',
        failed.provider, failed.model,
        klass,
        nextUp.provider, nextUp.model,
        Math.round(Math.max(cooldownMs, retryAfter) / 60_000),
      )
      done()
      return { kind: 'retry' }
    } catch (error) {
      ctx?.logger?.warn?.('model-failover: agent/request-error listener failed, passing through: %o', error)
      return next()
    }
  }, { prepend: true })

  return { pool }
}
