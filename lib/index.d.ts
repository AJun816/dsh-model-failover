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
import z from '@deepseek-ai/schemastery';
import type { LlmFailure } from '@deepseek-ai/dsh-llm';
/**
 * The slice of the agent loop's request-error recovery action this plugin
 * uses. Declared locally so the plugin compiles against any published
 * @deepseek-ai/dsh-agent version (structural, upgrade-tolerant).
 */
export type RequestErrorAction = {
    kind: 'retry';
} | undefined;
export declare const name = "model-failover";
export declare const inject: string[];
/** One fallback-hop: a provider (account) route plus the model to call on it. */
export interface FailoverEntry {
    provider: string;
    model: string;
}
/** A named, ordered fallback chain. */
export interface FailoverGroup {
    id: string;
    entries: FailoverEntry[];
}
/** Plugin configuration; lives in the user's cordis.patch.yml patch layer. */
export interface Config {
    /** Explicit fallback groups; when empty, the auto chain follows the configured model catalog. */
    groups?: FailoverGroup[];
    activeGroup?: string;
    cooldownMinutes?: number;
    retryOn?: string[];
    /** When true (default) and no groups are configured, every configured provider auto-joins the chain. */
    autoDiscover?: boolean;
    /** When true (default), an exhausted group falls back to any other healthy configured provider so the task never stops. */
    fallbackToCatalog?: boolean;
}
/**
 * Runtime schema for {@link Config}.
 */
export declare const Config: z<Config>;
/** Failure classes that can trigger a switchover. */
export declare const FAILURE_CLASSES: readonly ['quota', 'rate-limit', 'auth', 'network', 'other'];
export type FailureClass = typeof FAILURE_CLASSES[number];
/**
 * Parse a provider-stated resume time like "2026-11-05 17:10:49 后可继续使用"
 * (weekly/period usage caps) into remaining milliseconds. Local time assumed.
 */
export declare function retryAfterFromMessage(message: string | null | undefined, now?: number): number;
/**
 * Classify an LlmFailure into one of the failure classes. Code wins, message
 * keywords and HTTP status follow.
 */
export declare function classifyFailure(failure: LlmFailure | {
    message?: string;
    code?: string;
    status?: number;
} | null | undefined): FailureClass;
/** Account-level cooldown state machine. Cooling is keyed by provider. */
export interface AccountPool {
    cool(account: string, ms?: number): void;
    isCooling(account: string): boolean;
    recover(account: string): void;
    /** Force one cooled account back to healthy (a second-chance probe); reports whether it was cooling. */
    revive(account: string): boolean;
    snapshot(): Record<string, {
        coolingUntil: number;
    }>;
}
/**
 * Build a fresh account-pool state machine. Exposed for tests.
 * @param options.cooldownMs default cooldown duration in milliseconds
 * @param options.now clock, injectable for tests
 */
export declare function createPool(options: {
    cooldownMs: number;
    now?: () => number;
}): AccountPool;
/**
 * Resolve the active group from configuration. Unknown activeGroup falls
 * back to the first group.
 */
export declare function activeGroupOf(config: Config): FailoverGroup | undefined;
/** The slice of cordis Context this plugin touches; keeps coupling minimal. */
interface ListenerContext {
    on(event: string, listener: (payload: any, next: () => Promise<any>) => Promise<any>, options?: {
        prepend?: boolean;
    }): () => void;
    /** cordis effect: re-runs the factory when volatile config it reads changes. */
    effect?: (factory: () => () => void, label?: string) => void;
    /** The live LLM registry (declared via inject); drives auto-discovery. */
    llm?: {
        listProviders(): readonly {
            id: string;
            name?: string;
        }[];
        listModels(provider: string): Promise<readonly {
            id: string;
            name?: string;
        }[]>;
    };
    logger?: {
        info?: (format: string, ...args: unknown[]) => void;
        warn?: (format: string, ...args: unknown[]) => void;
    };
}
/** Test hooks for the apply() wiring. */
export interface ApplyInternals {
    pool?: AccountPool;
    now?: () => number;
}
/**
 * Install the failover listeners.
 * @param ctx plugin context
 * @param config resolved plugin configuration
 * @param internals test hooks
 */
export declare function apply(ctx: ListenerContext, config?: Config, internals?: ApplyInternals): {
    pool: AccountPool;
};
export {};
