/**
 * Durable account-health state: cool downs and provider-stated reset times.
 * The pool itself is per-process; without persistence every host restart
 * forgot that an account was capped until next week and re-tried it, so the
 * user burned one visible failure per dead account after each restart
 * (2026-11-16 incident: restart at 14:27, zai knobs re-tried in chain order).
 *
 * State lives in $DSH_HOME/model-failover/state.json next to switches.log.
 * On first use it is seeded from the switch log, which already records the
 * provider-stated resume times of earlier failures.
 *
 * @module dsh-model-failover/cooldowns
 */

import type { CooldownState, CooldownStore } from './types.js'
import { retryAfterFromMessage } from './classifier.js'

/** Ignore stored horizons beyond 30 days: a longer "reset" is bad data. */
const MAX_HORIZON_MS = 30 * 24 * 60 * 60_000
/** How many trailing switch-log lines seed the reset map. */
const SEED_LINES = 1000

interface ProcessFace {
  getBuiltinModule?: (id: string) => unknown
  env?: Record<string, string | undefined>
  pid?: number
}
interface FsFace {
  readFileSync?: (path: string, encoding: string) => string
  writeFileSync?: (path: string, data: string) => void
  mkdirSync?: (path: string, options?: { recursive?: boolean }) => void
  renameSync?: (from: string, to: string) => void
}
interface PathFace {
  join?: (...parts: string[]) => string
}
interface OsFace {
  homedir?: () => string
}

/** Keep only ids with a future, sane timestamp. */
function sanitize(input: unknown, now: number): Record<string, number> {
  const out: Record<string, number> = {}
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return out
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const until = Number(value)
    if (key === '' || !Number.isFinite(until)) continue
    if (until <= now || until - now > MAX_HORIZON_MS) continue
    out[key] = until
  }
  return out
}

/**
 * Provider-stated reset times from the switch log: every recorded failure
 * carries the provider's resume wording, so a fresh process can start with the
 * knowledge the previous one had.
 */
export function seedResetsFromLog(text: string, now: number): Record<string, number> {
  const resets: Record<string, number> = {}
  /** The newest failure statement wins: an earlier "until next week" must not
   *  outlive a later "resets at 14:32". */
  const latestAt: Record<string, number> = {}
  const lines = text.split('\n')
  const from = Math.max(0, lines.length - SEED_LINES)
  for (let i = from; i < lines.length; i += 1) {
    const line = (lines[i] ?? '').trim()
    if (line === '') continue
    let record: { at?: unknown, from?: unknown, reason?: unknown }
    try {
      record = JSON.parse(line) as { at?: unknown, from?: unknown, reason?: unknown }
    } catch { continue }
    if (typeof record.from !== 'string' || record.from === '') continue
    const reason = typeof record.reason === 'string' ? record.reason : ''
    // Only statements that NAME a resume time supersede an older one; a
    // failure without a date (plain 429) leaves the previous statement alone.
    if (!/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(reason)) continue
    const at = Number(record.at)
    const statedAt = Number.isFinite(at) ? at : 0
    if (statedAt < (latestAt[record.from] ?? 0)) continue
    latestAt[record.from] = statedAt
    const remaining = retryAfterFromMessage(reason, now)
    if (remaining > MAX_HORIZON_MS) continue
    // A newest statement whose resume time already passed means the cap is
    // over: clear the stale, longer horizon instead of keeping it.
    if (remaining <= 0) {
      delete resets[record.from]
    } else {
      resets[record.from] = now + remaining
    }
  }
  return resets
}

/**
 * Create the on-disk store. Returns undefined when Node builtins are
 * unreachable (non-Node host); callers then fall back to the process-local
 * pool, exactly as before.
 */
export function createCooldownStore(options: { directory?: string } = {}): CooldownStore | undefined {
  try {
    const proc = (globalThis as unknown as { process?: ProcessFace }).process
    const getBuiltin = proc?.getBuiltinModule
    if (typeof getBuiltin !== 'function') return undefined
    const fs = getBuiltin('node:fs') as FsFace
    const path = getBuiltin('node:path') as PathFace
    const os = getBuiltin('node:os') as OsFace
    const readFileSync = fs.readFileSync
    const writeFileSync = fs.writeFileSync
    const mkdirSync = fs.mkdirSync
    const renameSync = fs.renameSync
    const join = path.join
    const homedir = os.homedir
    if (typeof readFileSync !== 'function' || typeof writeFileSync !== 'function'
      || typeof join !== 'function' || typeof homedir !== 'function') return undefined
    const envHome = proc?.env?.DSH_HOME
    const home = envHome !== undefined && envHome.trim() !== '' ? envHome : join(homedir(), '.dsh')
    const directory = options.directory ?? join(home, 'model-failover')
    const file = join(directory, 'state.json')
    // Per-process temp file: several DSH hosts may share the state directory.
    const temp = file + '.' + String(proc?.pid ?? 'tmp') + '.tmp'
    return {
      load(now: number): CooldownState {
        let state: { cooling?: unknown, resets?: unknown } | undefined
        let seeded = false
        try {
          state = JSON.parse(readFileSync(file, 'utf8')) as { cooling?: unknown, resets?: unknown }
        } catch {
          // First run (or unreadable file): seed from the switch log instead.
          try {
            state = { resets: seedResetsFromLog(readFileSync(join(directory, 'switches.log'), 'utf8'), now) }
            seeded = true
          } catch { state = undefined }
        }
        const cooling = sanitize(state?.cooling, now)
        const resets = sanitize(state?.resets, now)
        if (!seeded && Object.keys(resets).length === 0) {
          // A state file without resets (older build) still benefits from the log.
          try {
            const seededResets = seedResetsFromLog(readFileSync(join(directory, 'switches.log'), 'utf8'), now)
            for (const [provider, until] of Object.entries(seededResets)) resets[provider] = until
          } catch { /* the switch log is optional */ }
        }
        return { cooling, resets }
      },
      save(next: CooldownState, now: number): void {
        try {
          const payload: CooldownState = { cooling: sanitize(next.cooling, now), resets: sanitize(next.resets, now) }
          mkdirSync?.(directory, { recursive: true })
          writeFileSync(temp, JSON.stringify(payload))
          renameSync?.(temp, file)
        } catch { /* persistence is advisory: never break a failover decision */ }
      },
    }
  } catch { return undefined }
}
