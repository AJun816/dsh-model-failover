/**
 * dsh-model-failover — automatic model & account failover for DeepSeek Harness.
 *
 * Listens to the two public agent-loop waterfalls:
 *  - `agent/request` (prepended): routes every model call to the first
 *    healthy entry of the active fallback group (array order = failover
 *    order). The configured chain is authoritative since v0.9.3; catalog
 *    fallback beyond it is opt-in via `fallbackToCatalog`.
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
 * Module map: types.ts (contracts) · coerce.ts (config reads) ·
 * classifier.ts (failure classes) · pool.ts (cooldowns) ·
 * records.ts (switch fan-out) · config.ts (schema + groups) · this file
 * (waterfall wiring).
 *
 * @module dsh-model-failover
 */
import type { AccountPool, ApplyInternals, Config, ListenerContext } from './types.js';
import { activeGroupOf, Config as ConfigBinding } from './config.js';
export declare const name = "model-failover";
export declare const inject: string[];
export { classifyFailure, providerExcluded, retryAfterFromMessage } from './classifier.js';
export { createPool } from './pool.js';
export { activeGroupOf };
export { ConfigBinding as Config };
export type { AccountPool, ApplyInternals, FailoverEntry, FailoverGroup, LlmCallConfig, ListenerContext, RequestErrorAction, SwitchRecord, WaterfallPayload, } from './types.js';
/**
 * Install the failover listeners.
 * @param ctx plugin context
 * @param config resolved plugin configuration
 * @param internals test hooks
 */
export declare function apply(ctx: ListenerContext, config?: Config, internals?: ApplyInternals): {
    pool: AccountPool;
};
