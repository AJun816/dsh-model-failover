/**
 * dsh-model-failover — automatic model & account failover for DeepSeek Harness.
 *
 * Listens to the two public agent-loop waterfalls:
 *  - `agent/request`: routes every model call to the first healthy entry of
 *    the active fallback group (array order = failover order).
 *  - `agent/request-error`: when a failure is classified as quota/rate-limit/
 *    auth/network, cools the failing entry down and answers { kind: 'retry' }
 *    so the loop re-runs agent/request on the next account.
 *
 * Zero third-party dependencies. Every listener is wrapped defensively: if
 * anything inside throws, it falls through to next() and DSH behaves exactly
 * as if the plugin were not installed.
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

/** Failure classes that trigger a switchover by default. */
export const FAILURE_CLASSES = ['quota', 'rate-limit', 'auth', 'network', 'other']

const CODE_CLASS = [
  [/^(ACCOUNT_)?QUOTA$/i, 'quota'],
  [/RATE_LIMIT/i, 'rate-limit'],
  [/^AUTH(ORIZATION|ENTICATION)?$/i, 'auth'],
  [/^NETWORK|TIMEOUT|CONNECTION/i, 'network'],
]

const MESSAGE_CLASS = [
  [/insufficient\s+balance|quota|额度|余额/i, 'quota'],
  [/rate\s*limit|too many requests/i, 'rate-limit'],
  [/invalid\s+api\s*key|unauthorized|forbidden|authentication/i, 'auth'],
  [/network|econnreset|econnrefused|etimedout|fetch failed|timeout/i, 'network'],
]

const STATUS_CLASS = new Map([
  [402, 'quota'], [429, 'rate-limit'], [401, 'auth'], [403, 'auth'],
])

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

const entryKey = (entry) => entry.provider + '/' + entry.model

/**
 * Build a fresh account-pool state machine. Exposed for tests.
 * @param {object} options
 * @param {number} options.cooldownMs cooldown duration in milliseconds
 * @param {() => number} [options.now] clock, injectable for tests
 */
export function createPool({ cooldownMs, now = () => Date.now() }) {
  /** @type {Map<string, { until: number }>} cooling entries by key */
  const cooling = new Map()

  function cool(key) {
    cooling.set(key, { until: now() + cooldownMs })
  }

  function isCooling(key) {
    const hit = cooling.get(key)
    if (hit === undefined) return false
    if (now() >= hit.until) {
      cooling.delete(key) // cooldown auto-recovery
      return false
    }
    return true
  }

  function recover(key) {
    cooling.delete(key)
  }

  function snapshot() {
    const out = {}
    for (const [key, { until }] of cooling) {
      if (now() < until) out[key] = { coolingUntil: until }
    }
    return out
  }

  return { cool, isCooling, recover, snapshot }
}

function firstHealthyEntry(entries, pool) {
  for (const entry of entries) {
    if (!pool.isCooling(entryKey(entry))) return entry
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

/**
 * Install the failover listeners.
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context
 * @param {Config} config resolved plugin configuration
 * @param {{ pool?: ReturnType<typeof createPool>, now?: () => number }} [internals] test hooks
 */
export function apply(ctx, config = {}, internals = {}) {
  const now = internals.now ?? (() => Date.now())
  const cooldownMs = Math.max(0, Number(config.cooldownMinutes ?? 30)) * 60_000
  const retryOn = new Set(Array.isArray(config.retryOn) ? config.retryOn : ['quota', 'rate-limit', 'auth', 'network'])
  const pool = internals.pool ?? createPool({ cooldownMs, now })
  const group = activeGroupOf(config)

  if (group === undefined || group.entries.length === 0) {
    ctx?.logger?.info?.('model-failover: no groups or entries configured — plugin stays inactive (pass-through)')
    return { pool }
  }
  ctx?.logger?.info?.(`model-failover: active group "${group.id}" with ${group.entries.length} entries (${group.entries.map((e) => entryKey(e)).join(' → ')})`)

  /**
   * Which entry the current in-flight request uses, per agent/session key.
   * agent/request selects before the call; agent/request-error cools the
   * entry that was actually in flight when that same agent fails.
   * @type {Map<string, FailoverEntry>}
   */
  const inFlight = new Map()

  const agentKey = (payload) => {
    const agent = payload?.agent ?? payload?.session?.agent
    const raw = agent?.session?.id ?? agent?.id
    const id = raw === undefined || raw === null ? 'default' : String(raw)
    return id === 'undefined' ? 'default' : id
  }

  ctx.on('agent/request', async (payload, next) => {
    try {
      const resolved = await next()
      const selected = firstHealthyEntry(group.entries, pool)
      if (selected === undefined) {
        inFlight.delete(agentKey(payload))
        return resolved // everyone cooling: pass through untouched
      }
      inFlight.set(agentKey(payload), selected)
      return { ...resolved, provider: selected.provider, model: selected.model }
    } catch (error) {
      ctx?.logger?.warn?.('model-failover: agent/request listener failed, passing through: %o', error)
      throw error
    }
  })

  ctx.on('agent/request-error', async (payload, next) => {
    try {
      const klass = classifyFailure(payload?.failure)
      if (!retryOn.has(klass)) return next()
      const key = agentKey(payload)
      const failed = inFlight.get(key)
      if (failed !== undefined) pool.cool(entryKey(failed))
      const nextUp = firstHealthyEntry(group.entries, pool)
      if (nextUp === undefined) {
        ctx?.logger?.warn?.(
          'model-failover: entry %s failed (%s) and every entry is cooling — giving up to default handling',
          failed ? entryKey(failed) : 'unknown', klass,
        )
        return next()
      }
      ctx?.logger?.info?.(
        'model-failover: %s failed (%s) → switching to %s (cooldown %d min)',
        failed ? entryKey(failed) : payload?.provider ?? 'unknown',
        klass,
        entryKey(nextUp),
        Math.round(cooldownMs / 60_000),
      )
      return { kind: 'retry' }
    } catch (error) {
      ctx?.logger?.warn?.('model-failover: agent/request-error listener failed, passing through: %o', error)
      return next()
    }
  })

  return { pool }
}
