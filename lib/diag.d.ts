/**
 * Best-effort diagnostics: append one JSON line to
 * $DSH_HOME/model-failover/diag.log. Used by the supervision/verification path
 * so "did the plugin see the agent / run the probe / move the selection?" is
 * answerable after the fact, without host stdout.
 *
 * @module dsh-model-failover/diag
 */
/** Append one diagnostic line; never throws, never blocks a decision. */
export declare function appendDiag(kind: string, fields?: Record<string, unknown>): void;
