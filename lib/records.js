/**
 * Switch recording: one switch fans out to three advisory channels —
 * a session plugin record, the plugin's JSONL log, and the GUI notice field.
 * Each channel is individually optional; a failure in one never blocks the
 * others, and nothing here may ever surface as an unhandled rejection.
 *
 * @module dsh-model-failover/records
 */
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
const SWITCH_RECORD_TYPE = 'plugin:model-failover/switch';
/** Cached once resolved; a failed lookup retries on the next switch (rare). */
let pluginRecordWriter;
async function resolvePluginRecordWriter() {
    if (pluginRecordWriter !== undefined)
        return pluginRecordWriter;
    try {
        // Runtime lookup of the in-process host module. The computed specifier
        // keeps this build dependency-free; when the channel is missing (older
        // host, plain-node tests without the stub) we simply skip it.
        const specifier = '@deepseek-ai/dsh-session';
        const mod = await import(specifier);
        if (typeof mod.appendPluginRecord === 'function')
            pluginRecordWriter = mod.appendPluginRecord;
    }
    catch { /* best effort: retry on the next switch */ }
    return pluginRecordWriter;
}
/**
 * Resolved-once default switch-log location: <plugin root>/switches.log, i.e.
 * next to lib/ in the installed plugin directory. Derived from import.meta.url
 * so it works for every install channel (git URL, npm, local path) and every
 * user — never a machine-specific absolute path.
 */
let defaultSwitchLog = false;
async function resolveDefaultSwitchLog() {
    if (defaultSwitchLog !== false)
        return defaultSwitchLog;
    defaultSwitchLog = undefined;
    try {
        // Computed-specifier dynamic imports keep the build independent of
        // @types/node; in the installed plugin import.meta.url is
        // <plugin>/lib/index.js, so the plugin root is one dirname up.
        const urlSpecifier = 'node:url';
        const pathSpecifier = 'node:path';
        const fsSpecifier = 'node:fs';
        const urlMod = await import(urlSpecifier);
        const pathMod = await import(pathSpecifier);
        const fsMod = await import(fsSpecifier);
        const meta = import.meta;
        const here = meta.url === undefined ? undefined : urlMod.fileURLToPath?.(meta.url);
        if (here === undefined || pathMod.dirname === undefined || pathMod.join === undefined)
            return undefined;
        const dir = pathMod.dirname(pathMod.dirname(here));
        fsMod.mkdirSync?.(dir, { recursive: true });
        defaultSwitchLog = pathMod.join(dir, 'switches.log');
    }
    catch { /* best effort: the file-log channel is optional */ }
    return defaultSwitchLog;
}
/** How many recent switches the GUI banner shows. */
const GUI_HISTORY_LENGTH = 5;
async function recordToSession(payload, record) {
    const session = payload.agent?.session;
    if (session === undefined)
        return;
    const write = await resolvePluginRecordWriter();
    write?.(session, SWITCH_RECORD_TYPE, record);
}
async function recordToLogFile(record, logFile) {
    const logTarget = logFile ?? await resolveDefaultSwitchLog();
    if (logTarget === undefined)
        return;
    // Computed specifier keeps the build independent of @types/node.
    const fsSpecifier = 'node:fs';
    const fs = await import(fsSpecifier);
    fs.appendFileSync?.(logTarget, JSON.stringify(record) + '\n');
}
async function recordToGuiNotice(ctx, record) {
    const settings = ctx.get?.('settings');
    if (settings === undefined)
        return;
    const described = await settings.describe();
    const view = described.namespaces?.find((row) => row.ns === 'model-failover');
    const history = [...(view?.value?.lastSwitches ?? []), record].slice(-GUI_HISTORY_LENGTH);
    await settings.update?.('model-failover', { lastSwitches: history }, view?.revision);
}
/**
 * Record one failover switch through every official channel. Each channel is
 * best-effort; a failure in one never blocks the others.
 */
export async function recordSwitch(ctx, payload, record, logFile) {
    await Promise.allSettled([
        recordToSession(payload, record),
        recordToLogFile(record, logFile),
        recordToGuiNotice(ctx, record),
    ]);
}
