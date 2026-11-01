/**
 * The cooled-account pool: which providers are temporarily out of rotation.
 * Cooldown state deliberately survives listener rewiring (volatile config
 * edits) so GUI changes never resurrect a just-failed account.
 *
 * @module dsh-model-failover/pool
 */

import type { AccountPool, FailoverEntry } from './types.js'

/**
 * Create a pool. The injectable clock keeps cooldowns testable.
 */
export function createPool(options: { cooldownMs: number, now?: () => number }): AccountPool {
  const { cooldownMs } = options
  const now = options.now ?? (() => Date.now())
  /** account -> cooling-until timestamp (ms). Absent = healthy. */
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

  function revive(account: string): boolean {
    const wasCooling = cooling.get(account) !== undefined
    cooling.delete(account)
    return wasCooling
  }

  function snapshot(): Record<string, { coolingUntil: number }> {
    const out: Record<string, { coolingUntil: number }> = {}
    for (const [account, { until }] of cooling) {
      if (now() < until) out[account] = { coolingUntil: until }
    }
    return out
  }

  return { cool, isCooling, recover, revive, snapshot }
}

/** The first entry of the chain whose provider is healthy, in chain order. */
export function firstHealthyEntry(entries: readonly FailoverEntry[], pool: AccountPool): FailoverEntry | undefined {
  return entries.find((entry) => !pool.isCooling(entry.provider))
}
