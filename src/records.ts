/**
 * Switch recording: one switch fans out to three advisory channels —
 * a session plugin record, the plugin's JSONL log, and the GUI notice field.
 * Each channel is individually optional; a failure in one never blocks the
 * others, and nothing here may ever surface as an unhandled rejection.
 *
 * @module dsh-model-failover/records
 */

import type { ListenerContext, SwitchRecord, WaterfallPayload } from './types.js'

/**
 * The session-record type for one failover switch. Plugin-authored records must
 * follow the official `plugin:` grammar and are written through
 * `appendPluginRecord`, which stamps the envelope's `ignorable: true` marker
 * so every harness build — including ones that do not know the type — can keep
 * reading the log. A plain required-event append of a custom type writes a
 * REQUIRED unknown event that the persistence reader refuses with "unknown to
 * this harness and not marked ignorable", breaking history load for that
 * session.
 */
const SWITCH_RECORD_TYPE = 'plugin:model-failover/switch'

/** The official `appendPluginRecord(session, type, data)` writer from the host. */
type PluginRecordWriter = (session: unknown, type: string, data: unknown) => unknown

/** Cached once resolved; a failed lookup retries on the next switch (rare). */
let pluginRecordWriter: PluginRecordWriter | undefined

async function resolvePluginRecordWriter(): Promise<PluginRecordWriter | undefined> {
  if (pluginRecordWriter !== undefined) return pluginRecordWriter
  try {
    // Runtime lookup of the in-process host module. The computed specifier
    // keeps this build dependency-free; when the channel is missing (older
    // host, plain-node tests without the stub) we simply skip it.
    const specifier = '@deepseek-ai/dsh-session'
    const mod = await import(specifier) as { appendPluginRecord?: PluginRecordWriter }
    if (typeof mod.appendPluginRecord === 'function') pluginRecordWriter = mod.appendPluginRecord
  } catch { /* best effort: retry on the next switch */ }
  return pluginRecordWriter
}

/**
 * Resolved-once default switch-log location: $DSH_HOME/model-failover/
 * switches.log — a stable per-user path that survives plugin reinstalls
 * (the pre-0.9.5 location inside the install tree was wiped by every
 * rm+reinstall). Falls back to ~/.dsh when DSH_HOME is unset.
 */
let defaultSwitchLog: string | undefined | false = false

async function resolveDefaultSwitchLog(): Promise<string | undefined> {
  if (defaultSwitchLog !== false) return defaultSwitchLog
  defaultSwitchLog = undefined
  try {
    // Computed-specifier dynamic imports keep the build independent of
    // @types/node. The switch log lives OUTSIDE the install tree since v0.9.5:
    // a log inside node_modules is destroyed by every plugin reinstall (an
    // rm+reinstall during the 2026-11-01 incident wiped the day's history).
    // Stable home: $DSH_HOME/model-failover/switches.log (default ~/.dsh/...).
    const osSpecifier = 'node:os'
    const pathSpecifier = 'node:path'
    const fsSpecifier = 'node:fs'
    const processSpecifier = 'node:process'
    const osMod = await import(osSpecifier) as { homedir?: () => string }
    const pathMod = await import(pathSpecifier) as { join?: (...parts: string[]) => string }
    const fsMod = await import(fsSpecifier) as { mkdirSync?: (path: string, options?: { recursive?: boolean }) => void }
    const processMod = await import(processSpecifier) as { env?: Record<string, string | undefined> }
    if (osMod.homedir === undefined || pathMod.join === undefined) return undefined
    const envHome = processMod.env?.DSH_HOME
    const home = (envHome !== undefined && envHome.trim() !== '' ? envHome : undefined)
      ?? osMod.homedir() + '/.dsh'
    const dir = pathMod.join(home, 'model-failover')
    fsMod.mkdirSync?.(dir, { recursive: true })
    defaultSwitchLog = pathMod.join(dir, 'switches.log')
  } catch { /* best effort: the file-log channel is optional */ }
  return defaultSwitchLog
}

interface SettingsFace {
  describe(): Promise<{ namespaces?: Array<{ ns: string, value?: { lastSwitches?: SwitchRecord[] }, revision?: number }> }>
  update?(ns: string, patch: Record<string, unknown>, revision?: number): Promise<unknown>
}

/** How many recent switches the GUI banner shows. */
const GUI_HISTORY_LENGTH = 5

async function recordToSession(payload: WaterfallPayload, record: SwitchRecord): Promise<void> {
  const session = payload.agent?.session
  if (session === undefined) return
  const write = await resolvePluginRecordWriter()
  write?.(session, SWITCH_RECORD_TYPE, record)
}

async function recordToLogFile(record: SwitchRecord, logFile: string | undefined): Promise<void> {
  const logTarget = logFile ?? await resolveDefaultSwitchLog()
  if (logTarget === undefined) return
  // Computed specifier keeps the build independent of @types/node.
  const fsSpecifier = 'node:fs'
  const fs = await import(fsSpecifier) as { appendFileSync?: (path: string, data: string) => void }
  fs.appendFileSync?.(logTarget, JSON.stringify(record) + '\n')
}

async function recordToGuiNotice(ctx: ListenerContext, record: SwitchRecord): Promise<void> {
  const settings = (ctx as unknown as { get?: (name: string) => unknown }).get?.('settings') as SettingsFace | undefined
  if (settings === undefined) return
  const described = await settings.describe()
  const view = described.namespaces?.find((row) => row.ns === 'model-failover')
  const history = [...(view?.value?.lastSwitches ?? []), record].slice(-GUI_HISTORY_LENGTH)
  await settings.update?.('model-failover', { lastSwitches: history }, view?.revision)
}

/**
 * Record one failover switch through every official channel. Each channel is
 * best-effort; a failure in one never blocks the others.
 */
export async function recordSwitch(
  ctx: ListenerContext,
  payload: WaterfallPayload,
  record: SwitchRecord,
  logFile: string | undefined,
): Promise<void> {
  await Promise.allSettled([
    recordToSession(payload, record),
    recordToLogFile(record, logFile),
    recordToGuiNotice(ctx, record),
  ])
}
