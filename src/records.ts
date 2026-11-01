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
 * Resolved-once default switch-log location: <plugin root>/switches.log, i.e.
 * next to lib/ in the installed plugin directory. Derived from import.meta.url
 * so it works for every install channel (git URL, npm, local path) and every
 * user — never a machine-specific absolute path.
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
