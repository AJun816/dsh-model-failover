/**
 * Failure classification and provider exclusion.
 *
 * The classifier maps an LlmFailure onto a small set of switch-driving
 * classes. Code wins, HTTP status follows, message keywords are the last
 * resort — every rule here exists because a real provider emitted it.
 *
 * @module dsh-model-failover/classifier
 */
import type { LlmFailure } from './types.js';
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
/**
 * True when a provider id matches a catalogExclude pattern. A pattern is an
 * exact id ("workbuddy-ai") or a prefix wildcard ("workbuddy-*"); empty and
 * malformed patterns never match.
 */
export declare function providerExcluded(patterns: readonly unknown[], provider: string): boolean;
