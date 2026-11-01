/**
 * Switch recording: one switch fans out to three advisory channels —
 * a session plugin record, the plugin's JSONL log, and the GUI notice field.
 * Each channel is individually optional; a failure in one never blocks the
 * others, and nothing here may ever surface as an unhandled rejection.
 *
 * @module dsh-model-failover/records
 */
import type { ListenerContext, SwitchRecord, WaterfallPayload } from './types.js';
/** One armed-state snapshot, written to the settings namespace at every wire(). */
export interface ArmedState {
    at: number;
    version: string;
    group: string;
    entries: number;
    mode: 'active' | 'inactive';
    note?: string;
}
/**
 * Append one line to $DSH_HOME/model-failover/load.log — external proof that
 * this module was EVALUATED inside the host process (version + pid), and the
 * only channel that also captures why apply()/wire() failed to arm. Writing
 * is fire-and-forget and never throws into module evaluation.
 */
export declare function writeLoadMarker(version: string, note?: string): Promise<void>;
/**
 * Persist the armed-state snapshot into the settings namespace so the running
 * plugin's status is observable WITHOUT host stdout (the heartbeat log line is
 * invisible to external tooling; this field is readable from the config
 * surface the GUI card already serves).
 */
export declare function recordArmed(ctx: ListenerContext, state: ArmedState): Promise<void>;
/**
 * Record one failover switch through every official channel. Each channel is
 * best-effort; a failure in one never blocks the others.
 */
export declare function recordSwitch(ctx: ListenerContext, payload: WaterfallPayload, record: SwitchRecord, logFile: string | undefined): Promise<void>;
