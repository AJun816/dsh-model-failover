/**
 * Switch recording: one switch fans out to three advisory channels —
 * a session plugin record, the plugin's JSONL log, and the GUI notice field.
 * Each channel is individually optional; a failure in one never blocks the
 * others, and nothing here may ever surface as an unhandled rejection.
 *
 * @module dsh-model-failover/records
 */
import type { ListenerContext, SwitchRecord, WaterfallPayload } from './types.js';
/**
 * Record one failover switch through every official channel. Each channel is
 * best-effort; a failure in one never blocks the others.
 */
export declare function recordSwitch(ctx: ListenerContext, payload: WaterfallPayload, record: SwitchRecord, logFile: string | undefined): Promise<void>;
