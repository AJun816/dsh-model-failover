/**
 * Shared structural types. Everything the plugin exchanges with the host is
 * declared locally (upgrade-tolerant): the plugin compiles against any
 * published @deepseek-ai/* version and tolerates new fields at runtime.
 *
 * @module dsh-model-failover/types
 */
import type { LlmCallConfig, LlmFailure } from '@deepseek-ai/dsh-llm';
export type { LlmCallConfig, LlmFailure };
/** The slice of the agent loop's request-error recovery action this plugin emits. */
export type RequestErrorAction = {
    kind: 'retry';
} | undefined;
/** One fallback hop: a provider (account) route plus the model to call on it. */
export interface FailoverEntry {
    provider: string;
    model: string;
}
/** A named, ordered fallback chain; array order is the failover order. */
export interface FailoverGroup {
    id: string;
    entries: FailoverEntry[];
}
/** One recorded failover switch, surfaced in the GUI card and logs. */
export interface SwitchRecord {
    at: number;
    from: string;
    to: string;
    reason: string;
    via: 'chain' | 'fallback' | 'second-chance';
}
/** Plugin configuration; lives in the user's cordis.patch.yml patch layer. */
export interface Config {
    /** Explicit fallback groups; when empty, the auto chain follows the configured model catalog. */
    groups?: FailoverGroup[];
    activeGroup?: string;
    cooldownMinutes?: number;
    /** Failure classes that trigger a switchover. */
    retryOn?: string[];
    /** When true (default) and no groups are configured, every configured provider auto-joins the chain. */
    autoDiscover?: boolean;
    /**
     * When true, an exhausted group may fall back to a healthy provider OUTSIDE
     * the configured chain. Default false since v0.9.3: the configured chain is
     * authoritative and catalog fallback is opt-in (it once routed traffic into
     * a channel the user never configured — see CHANGELOG 0.9.2/0.9.3).
     */
    fallbackToCatalog?: boolean;
    /** Provider-name patterns excluded from the auto chain and catalog fallback. Exact id, or prefix with trailing *. */
    catalogExclude?: string[];
    /** Recent switch records the GUI card surfaces as a notice (host-written, advisory). */
    lastSwitches?: SwitchRecord[];
}
/** The slice of cordis Context this plugin touches; keeps coupling minimal. */
export interface ListenerContext {
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
/** Waterfall payload shapes this plugin reads (structural, upgrade-tolerant). */
export interface WaterfallPayload {
    agent?: {
        id?: unknown;
        session?: {
            id?: unknown;
        };
    };
    turn?: number;
    step?: number;
    provider?: string;
    failure?: LlmFailure;
}
/** Test hooks for the apply() wiring. */
export interface ApplyInternals {
    pool?: AccountPool;
    now?: () => number;
    /** Override path for the plugin's switch log (tests). */
    logFile?: string;
}
/** Cooled-account pool contract (see pool.ts). */
export interface AccountPool {
    cool(account: string, ms?: number): void;
    isCooling(account: string): boolean;
    recover(account: string): void;
    revive(account: string): boolean;
    snapshot(): Record<string, {
        coolingUntil: number;
    }>;
}
