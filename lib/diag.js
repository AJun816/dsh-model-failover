/**
 * Best-effort diagnostics: append one JSON line to
 * $DSH_HOME/model-failover/diag.log. Used by the supervision/verification path
 * so "did the plugin see the agent / run the probe / move the selection?" is
 * answerable after the fact, without host stdout.
 *
 * @module dsh-model-failover/diag
 */
/** Append one diagnostic line; never throws, never blocks a decision. */
export function appendDiag(kind, fields = {}) {
    try {
        const proc = globalThis.process;
        const getBuiltin = proc?.getBuiltinModule;
        if (typeof getBuiltin !== 'function')
            return;
        const fs = getBuiltin('node:fs');
        const path = getBuiltin('node:path');
        const os = getBuiltin('node:os');
        const append = fs.appendFileSync;
        const join = path.join;
        const homedir = os.homedir;
        if (typeof append !== 'function' || typeof join !== 'function' || typeof homedir !== 'function')
            return;
        const envHome = proc?.env?.DSH_HOME;
        const home = envHome !== undefined && envHome.trim() !== '' ? envHome : join(homedir(), '.dsh');
        const dir = join(home, 'model-failover');
        fs.mkdirSync?.(dir, { recursive: true });
        append(join(dir, 'diag.log'), JSON.stringify({
            at: new Date().toISOString(),
            pid: proc?.pid,
            kind,
            ...fields,
        }) + '\n');
    }
    catch { /* diagnostics are advisory */ }
}
