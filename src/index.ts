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
export const inject = ['llm']

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
  /** Explicit fallback groups; when empty, the auto chain follows the configured model catalog. */
  groups?: FailoverGroup[]
  activeGroup?: string
  cooldownMinutes?: number
  retryOn?: string[]
  /** When true (default) and no groups are configured, every configured provider auto-joins the chain. */
  autoDiscover?: boolean
  /** When true (default), an exhausted group falls back to any other healthy configured provider so the task never stops. */
  fallbackToCatalog?: boolean
  /** Recent switch records the GUI card surfaces as a notice (host-written, advisory). */
  lastSwitches?: SwitchRecord[]
}

/** One recorded failover switch, surfaced in the GUI card and logs. */
export interface SwitchRecord {
  at: number
  from: string
  to: string
  reason: string
  via: 'chain' | 'fallback' | 'second-chance'
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
  autoDiscover: z.boolean().default(true).volatile(),
  fallbackToCatalog: z.boolean().default(true).volatile(),
  lastSwitches: z.array(z.object({
    at: z.number().required(),
    from: z.string().required(),
    to: z.string().required(),
    reason: z.string().required(),
    via: z.string().required(),
  })).default([]).volatile(),
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
  [/insufficient\s+balance|quota|额度|余额|使用上限|usage\s*limit/i, 'quota'],
  [/rate\s*limit|too many requests|限流|请求过于频繁|稍后(再试|重试)/i, 'rate-limit'],
  [/invalid\s+api\s*key|unauthorized|forbidden|authentication/i, 'auth'],
  [/network|econnreset|econnrefused|etimedout|fetch failed|timeout|overload|服务繁忙/i, 'network'],
]

/**
 * Parse a provider-stated resume time like "2026-11-05 17:10:49 后可继续使用"
 * (weekly/period usage caps) into remaining milliseconds. Local time assumed.
 */
export function retryAfterFromMessage(message: string | null | undefined, now: number = Date.now()): number {
  if (typeof message !== 'string' || message === '') return 0
  const hit = /(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(:\d{2})?)/.exec(message)
  if (hit === null) return 0
  const time = hit[3] === undefined ? hit[2] + ':00' : hit[2]
  const until = Date.parse(hit[1] + 'T' + time)
  return Number.isFinite(until) ? Math.max(0, until - now) : 0
}

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
  // A numeric string code ("429", "1310"-style HTTP echoes) maps like a status.
  const numeric = /^\d{3}$/.test(code) ? Number(code) : undefined
  const statusHit = STATUS_CLASS.get(failure.status ?? numeric ?? NaN)
  if (statusHit !== undefined) return statusHit
  if (/^13[0-9]{2}$/.test(code)) return code === '1302' ? 'rate-limit' : 'quota'
  const message = String(failure.message ?? '')
  for (const [pattern, klass] of MESSAGE_CLASS) if (pattern.test(message)) return klass
  return 'other'
}

/** Account-level cooldown state machine. Cooling is keyed by provider. */
export interface AccountPool {
  cool(account: string, ms?: number): void
  isCooling(account: string): boolean
  recover(account: string): void
  /** Force one cooled account back to healthy (a second-chance probe); reports whether it was cooling. */
  revive(account: string): boolean
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

/** Volatile fields may be plain values or live refs exposing .get(); read both. */
function valueOf<T>(value: unknown): T | undefined {
  if (value !== null && typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function') {
    try { return (value as { get: () => T }).get() } catch { return undefined }
  }
  return value as T
}

function entriesOf(value: unknown): FailoverEntry[] {
  const inner = valueOf<FailoverEntry[]>(value)
  return Array.isArray(inner) ? inner : []
}

function stringOf(value: unknown): string {
  const inner = valueOf<string>(value)
  return typeof inner === 'string' ? inner : ''
}

function stringListOf(value: unknown): string[] {
  const inner = valueOf<string[]>(value)
  return Array.isArray(inner) ? inner : []
}

function boolOf(value: unknown, fallback: boolean): boolean {
  const inner = valueOf<boolean>(value)
  return typeof inner === 'boolean' ? inner : fallback
}

function numberOr(value: unknown, fallback: number): number {
  const inner = valueOf<number>(value)
  return typeof inner === 'number' && Number.isFinite(inner) ? inner : fallback
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

/**
 * The session-record type for one failover switch. Plugin-authored records must
 * follow the official `plugin:` grammar (`plugin:` + lowercase slash-separated
 * segments) and are written through `appendPluginRecord`, which stamps the
 * envelope's `ignorable: true` marker so every harness build — including ones
 * that do not know the type — can keep reading the log. A plain
 * `session.append('model-failover/switch', …)` writes a REQUIRED unknown event
 * that the persistence reader refuses with "unknown to this harness and not
 * marked ignorable", breaking history load for that session.
 */
const SWITCH_RECORD_TYPE = 'plugin:model-failover/switch'

/** The official `appendPluginRecord(session, type, data)` writer from the host. */
type PluginRecordWriter = (session: unknown, type: string, data: unknown) => unknown

/** Cached once resolved; a failed lookup retries on the next switch (rare). */
let pluginRecordWriter: PluginRecordWriter | undefined

async function resolvePluginRecordWriter(): Promise<PluginRecordWriter | undefined> {
  if (pluginRecordWriter !== undefined) return pluginRecordWriter
  try {
    // Runtime lookup of the in-process host module (the same modules sibling
    // plugins like dsh-web-search-zhipu import statically). The computed
    // specifier keeps this build dependency-free; when the channel is missing
    // (older host, plain-node tests without the stub) we simply skip it.
    const specifier = '@deepseek-ai/dsh-session'
    const mod = await import(specifier) as { appendPluginRecord?: PluginRecordWriter }
    if (typeof mod.appendPluginRecord === 'function') pluginRecordWriter = mod.appendPluginRecord
  } catch { /* best effort: retry on the next switch */ }
  return pluginRecordWriter
}

/**
 * Resolved-once default switch-log location: <plugin root>/switches.log, i.e.
 * next to lib/ in the installed plugin directory. Derived from
 * import.meta.url so it works for every install channel (git URL, npm, local
 * path) and every user — never a machine-specific absolute path.
 */
let defaultSwitchLog: string | undefined | false = false

async function resolveDefaultSwitchLog(): Promise<string | undefined> {
  if (defaultSwitchLog !== false) return defaultSwitchLog
  defaultSwitchLog = undefined
  try {
    // Computed-specifier dynamic imports keep the build independent of
    // @types/node; in the installed plugin import.meta.url is
    // <plugin>/lib/index.js, so the plugin root is one dirname up.
    const urlSpecifier = 'node:url'
    const pathSpecifier = 'node:path'
    const fsSpecifier = 'node:fs'
    const urlMod = await import(urlSpecifier) as { fileURLToPath?: (url: string) => string }
    const pathMod = await import(pathSpecifier) as { dirname?: (p: string) => string, join?: (...parts: string[]) => string }
    const fsMod = await import(fsSpecifier) as { mkdirSync?: (path: string, options?: { recursive?: boolean }) => void }
    const meta = import.meta as unknown as { url?: string }
    const here = meta.url === undefined ? undefined : urlMod.fileURLToPath?.(meta.url)
    if (here === undefined || pathMod.dirname === undefined || pathMod.join === undefined) return undefined
    const dir = pathMod.dirname(pathMod.dirname(here))
    fsMod.mkdirSync?.(dir, { recursive: true })
    defaultSwitchLog = pathMod.join(dir, 'switches.log')
  } catch { /* best effort: the file-log channel is optional */ }
  return defaultSwitchLog
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
async function recordSwitch(ctx: ListenerContext, payload: WaterfallPayload & { agent?: { session?: unknown } }, record: SwitchRecord, logFile: string | undefined): Promise<void> {
  // 1) session transcript plugin record (official ignorable channel; llm-retry's
  //    `session.append` path is reserved for harness-known event types)
  try {
    const session = payload.agent?.session
    if (session !== undefined) {
      const write = await resolvePluginRecordWriter()
      write?.(session, SWITCH_RECORD_TYPE, record)
    }
  } catch { /* best effort */ }
  // 2) plugin file log (types-free dynamic imports keep the build independent of @types/node)
  const logTarget = logFile ?? await resolveDefaultSwitchLog()
  if (logTarget !== undefined) {
    try {
      // @ts-ignore runtime-provided node builtin; typing it would force @types/node into the build
      const fs = await import('node:fs') as { appendFileSync?: (path: string, data: string) => void }
      fs.appendFileSync?.(logTarget, JSON.stringify(record) + '\n')
    } catch { /* best effort */ }
  }
  // 3) settings namespace (GUI notice); best effort with a describe-read-update cycle
  try {
    interface SettingsFace {
      describe(): Promise<{ namespaces?: Array<{ ns: string, value?: { lastSwitches?: SwitchRecord[] }, revision?: number }> }>
      update?(ns: string, patch: Record<string, unknown>, revision?: number): Promise<unknown>
    }
    const settings = (ctx as unknown as { get?: (name: string) => unknown }).get?.('settings') as SettingsFace | undefined
    if (settings === undefined) return
    const described = await settings.describe()
    const view = described.namespaces?.find((row) => row.ns === 'model-failover')
    const history = [...(view?.value?.lastSwitches ?? []), record].slice(-5)
    await settings.update?.('model-failover', { lastSwitches: history }, view?.revision)
  } catch { /* best effort: never block the retry decision */ }
}

/** The slice of cordis Context this plugin touches; keeps coupling minimal. */
interface ListenerContext {
  on(event: string, listener: (payload: any, next: () => Promise<any>) => Promise<any>, options?: { prepend?: boolean }): () => void
  /** cordis effect: re-runs the factory when volatile config it reads changes. */
  effect?: (factory: () => () => void, label?: string) => void
  /** The live LLM registry (declared via inject); drives auto-discovery. */
  llm?: {
    listProviders(): readonly { id: string, name?: string }[]
    listModels(provider: string): Promise<readonly { id: string, name?: string }[]>
  }
  logger?: {
    info?: (format: string, ...args: unknown[]) => void
    warn?: (format: string, ...args: unknown[]) => void
  }
}

/** Test hooks for the apply() wiring. */
export interface ApplyInternals {
  pool?: AccountPool
  now?: () => number
  /** Override path for the plugin's switch log (tests). */
  logFile?: string
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
  /** Explicit log path (tests); production derives it from the plugin dir. */
  const logFile = internals.logFile
  /** Record a switch through all channels without blocking the retry decision. */
  const note = (payload: WaterfallPayload, from: string, to: string, reason: string, via: SwitchRecord['via']): void => {
    // Recording is advisory: swallow even programming errors so no switch can
    // ever surface as an unhandled rejection inside the host process.
    recordSwitch(ctx, payload as Parameters<typeof recordSwitch>[1], { at: now(), from, to, reason, via }, logFile)
      .catch(() => { /* every channel already degraded on its own */ })
  }
  const pool = internals.pool ?? createPool({ cooldownMs: 30 * 60_000, now })

  /** Which entry the current in-flight request uses, per agent key. */
  const inFlight = new Map<string, FailoverEntry>()
  /** Consecutive failover retries per agent key and turn/step. */
  const retryBudget = new Map<string, number>()
  /** Catalog-fallback hops per agent key and turn/step (separate small budget). */
  const fallbackBudget = new Map<string, number>()
  /** Last second-chance revive per provider, throttling probes on fully-cooled pools. */
  const lastRevive = new Map<string, number>()
  /** Minimum spacing between second-chance probes of one provider. */
  const REVIVE_INTERVAL_MS = 5 * 60_000

  const agentKey = (payload: WaterfallPayload | undefined): string | undefined => {
    const agent = payload?.agent
    const raw = agent?.session?.id ?? agent?.id
    return raw === undefined || raw === null ? undefined : String(raw)
  }

  /**
   * Auto-discovered chain: one entry per configured provider (its first
   * model), in registry order. Built from the public llm service; refreshed
   * on adapter topology changes. Empty while the registry is unavailable.
   */
  let autoEntries: FailoverEntry[] = []
  const llm = (ctx as ListenerContext).llm
  const refreshAuto = async (): Promise<void> => {
    if (llm === undefined) return
    try {
      const entries: FailoverEntry[] = []
      for (const provider of llm.listProviders()) {
        try {
          const models = await llm.listModels(provider.id)
          const first = models[0]
          if (first !== undefined) entries.push({ provider: provider.id, model: first.id })
        } catch { /* a provider whose catalog fails is skipped this round */ }
      }
      autoEntries = entries
    } catch (error) {
      ;(ctx as ListenerContext).logger?.warn?.('model-failover: auto-discovery failed: %o', error)
    }
  }
  void refreshAuto()
  ;(ctx as ListenerContext).on('llm/adapters-updated', (() => { void refreshAuto() }) as never)

  /**
   * Wire the listeners from the current (volatile) config. Re-run by cordis
   * whenever a volatile field changes, so GUI edits apply without a restart;
   * the pool's cooling state deliberately survives re-wiring.
   */
  const wire = (): (() => void) => {
    const cooldownMs = numberOr(config.cooldownMinutes, 30) * 60_000
    const retryOn = new Set(stringListOf(config.retryOn).length > 0 ? stringListOf(config.retryOn) : ['quota', 'rate-limit', 'auth', 'network'])
    const autoOn = boolOf(config.autoDiscover, true)
    const fallbackOn = boolOf(config.fallbackToCatalog, true)
    /** First healthy entry outside the active group (catalog fallback). */
    const fallbackEntry = (): FailoverEntry | undefined => {
      if (!fallbackOn || group === undefined) return undefined
      const inGroup = new Set(group.entries.map((entry) => entry.provider))
      return autoEntries.find((entry) => !inGroup.has(entry.provider) && !pool.isCooling(entry.provider))
    }

    const groupsRaw = valueOf<FailoverGroup[]>(config.groups)
    const groupsValue = Array.isArray(groupsRaw) ? groupsRaw : []
    let group: FailoverGroup | undefined = activeGroupOf({ groups: groupsValue, activeGroup: stringOf(config.activeGroup) })
    if (groupsValue.length === 0 && autoOn) {
      group = { id: 'auto', entries: autoEntries }
    }

    if (group === undefined || group.entries.length === 0) {
      ;(ctx as ListenerContext).logger?.info?.('model-failover: no groups or entries configured — plugin stays inactive (pass-through)')
      return () => {}
    }
    ;(ctx as ListenerContext).logger?.info?.(`model-failover: active group "${group.id}" with ${group.entries.length} entries (${group.entries.map((e) => e.provider + '/' + e.model).join(' → ')})`)

    const offRequest = (ctx as ListenerContext).on('agent/request', async (payload: WaterfallPayload, next: () => Promise<LlmCallConfig>) => {
    // Downstream (inner-listener) errors propagate unchanged: they are not
    // ours to swallow. Only OUR routing below degrades to pass-through.
    const resolved = await next()
    try {
      if (resolved === null || typeof resolved !== 'object') return resolved // nothing sane to reroute
      const selected = firstHealthyEntry(group.entries, pool) ?? fallbackEntry()
      const key = agentKey(payload)
      if (selected === undefined || key === undefined) {
        if (key !== undefined) inFlight.delete(key)
        return resolved // everyone cooling or untrackable: pass through untouched
      }
      if (inFlight.size > 64) inFlight.clear() // bounded: entries are per agent key, pruned on error paths
      inFlight.set(key, selected)
      return reroute(resolved, selected)
    } catch (error) {
      ;(ctx as ListenerContext).logger?.warn?.('model-failover: agent/request routing failed, passing through: %o', error)
      return resolved // behave as if the plugin were not installed
    }
    // Prepend: the OUTERMOST listener's return value is the final routing
    // config. agent-default-model (and any other outer listener) may return
    // its own config and discard downstream edits when the turn uses the
    // "Default" model selection — prepending here makes our failover reroute
    // the value the loop actually uses.
    }, { prepend: true })

    // Prepend so this listener always runs before same-waterfall recovery
    // policies (e.g. llm-retry): the account is cooled no matter who decides
    // the retry, and downstream backoff is preserved by always delegating.
    const offRequestError = (ctx as ListenerContext).on('agent/request-error', async (payload: WaterfallPayload, next: () => Promise<RequestErrorAction | undefined>) => {
    let delegated = false // whether next() already ran — never run it twice
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
      const retryAfter = Math.max(
        finiteOr(failure?.providerRetryAfterMs, 0),
        retryAfterFromMessage((failure as { message?: string } | null | undefined)?.message, now()),
      )
      pool.cool(failed.provider, Math.max(cooldownMs, retryAfter))

      // Instant failover: switching to a DIFFERENT healthy account needs no
      // backoff, so we answer { kind: 'retry' } directly instead of delegating
      // to llm-retry (whose listener would sleep on its exponential delay
      // before returning the same decision). Downstream recovery still handles
      // every case we cannot solve ourselves below.
      let used = 1
      if (stepKey === undefined) {
        // Unkeyed agents cannot accumulate a budget; the pool bound still applies.
        used = 1
      } else {
        used = (retryBudget.get(stepKey) ?? 0) + 1
        retryBudget.set(stepKey, used)
      }
      if (retryBudget.size > 1000) retryBudget.clear()

      const groupNext = firstHealthyEntry(group.entries, pool)
      const fbNext = groupNext === undefined ? fallbackEntry() : undefined
      const nextUp = groupNext ?? fbNext
      // Catalog-fallback hops get their own small budget so a group pass stays bounded.
      let fallbackOk = false
      if (fbNext !== undefined) {
        if (stepKey === undefined) fallbackOk = true
        else {
          const used2 = (fallbackBudget.get(stepKey) ?? 0) + 1
          fallbackBudget.set(stepKey, used2)
          if (fallbackBudget.size > 1000) fallbackBudget.clear()
          fallbackOk = used2 <= 2
        }
      }
      if (nextUp !== undefined && (used <= group.entries.length || fallbackOk)) {
        note(payload, failed.provider, nextUp.provider, klass, fbNext !== undefined && groupNext === undefined ? 'fallback' : 'chain')
        ;(ctx as ListenerContext).logger?.info?.(
          'model-failover: %s/%s failed (%s) → switching to %s/%s (cooldown %d min)',
          failed.provider, failed.model,
          klass,
          nextUp.provider, nextUp.model,
          Math.round(Math.max(cooldownMs, retryAfter) / 60_000),
        )
        done()
        return { kind: 'retry' }
      }

      // Second chance: every account is cooling, but the user may have
      // recharged one meanwhile. Revive the first cooled entry (chain order,
      // throttled to one probe per provider per REVIVE_INTERVAL_MS) and let the
      // real request itself probe it — success means real quota, a retryable
      // failure simply re-cools it (extends-only) at no extra cost.
      if (nextUp === undefined && used <= group.entries.length + 1) {
        const candidate = group.entries.find((entry) => {
          if (!pool.isCooling(entry.provider)) return false
          const last = lastRevive.get(entry.provider) ?? Number.NEGATIVE_INFINITY
          return now() - last >= REVIVE_INTERVAL_MS
        })
        if (candidate !== undefined) {
          lastRevive.set(candidate.provider, now())
          pool.revive(candidate.provider)
          note(payload, failed.provider, candidate.provider, klass + '/second-chance', 'second-chance')
          ;(ctx as ListenerContext).logger?.info?.(
            'model-failover: every account is cooling — second-chance retry on %s (recharged?)',
            candidate.provider,
          )
          done()
          return { kind: 'retry' }
        }
      }

      let downstream: RequestErrorAction | undefined
      try {
        downstream = await next()
      } catch (error) {
        downstream = undefined
        ;(ctx as ListenerContext).logger?.warn?.('model-failover: downstream recovery failed: %o', error)
      }
      delegated = true // next() ran (throwing or not): never call it again
      if (downstream?.kind === 'retry') {
        done()
        return downstream
      }
      if (nextUp !== undefined) {
        ;(ctx as ListenerContext).logger?.warn?.(
          'model-failover: retry budget exhausted for %s after %d attempts — giving up to default handling',
          stepKey, used,
        )
      } else {
        ;(ctx as ListenerContext).logger?.warn?.(
          'model-failover: %s failed (%s) and every account is cooling — giving up to default handling',
          failed.provider, klass,
        )
      }
      done()
      return downstream
    } catch (error) {
      ;(ctx as ListenerContext).logger?.warn?.('model-failover: agent/request-error listener failed, passing through: %o', error)
      // If next() already ran above, delegating again would execute downstream
      // recovery (e.g. llm-retry) twice; degrade to "no action" instead.
      return delegated ? undefined : next()
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